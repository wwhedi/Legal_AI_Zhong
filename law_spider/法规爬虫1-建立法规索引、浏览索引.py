import json
import os
import subprocess
import requests
import re
import time
import sys
import random
from bs4 import BeautifulSoup

# 避免 Windows/GBK 控制台在打印生僻字时抛出 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    # 某些运行环境（如被外部管道包装）可能不支持 reconfigure
    pass

# 分类编码（按网页筛选结构）
TYPE_TO_FLFG_CODE_IDS = {
    # 宪法
    'xf': [100],  # 宪法

    # 法律
    'flfg': [
        110,  # 法律-宪法相关法
        120,  # 法律-民法商法
        130,  # 法律-行政法
        140,  # 法律-经济法
        150,  # 法律-社会法
        155,  # 法律-生态环境法
        160,  # 法律-刑法
        170,  # 法律-诉讼与非诉讼程序法
        180,  # 法律-法律解释
        190,  # 法律-有关法律问题和重大问题的决定（部分）
        195,  # 法律-修正案
        200   # 法律-修改、废止的决定
    ],

    # 行政法规
    'xzfg': [
        210,  # 行政法规-行政法规
        215   # 行政法规-修改、废止的决定
    ],

    # 监察法规
    'jcfg': [220],  # 监察法规

    # 地方法规
    'dfxfg': [
        230,  # 地方法规-地方性法规
        260,  # 地方法规-自治条例
        270,  # 地方法规-单行条例
        290,  # 地方法规-经济特区法规
        295,  # 地方法规-浦东新区法规
        300,  # 地方法规-海南自由贸易港法规
        305,  # 地方法规-法规性决定
        310   # 地方法规-修改、废止的决定
    ],

    # 司法解释
    'sfjs': [
        320,  # 司法解释-高法司法解释
        330,  # 司法解释-高检司法解释
        340,  # 司法解释-联合发布司法解释
        350   # 司法解释-修改、废止的决定
    ]
}
ERROR_LOG_PATH = os.path.join(os.path.dirname(__file__), 'error.log')
REQUEST_BASE_DELAY = 1.0
REQUEST_JITTER = 1.2
REQUEST_MAX_RETRY = 4
BACKOFF_BASE = 2


def polite_sleep(multiplier=1.0):
    delay = (REQUEST_BASE_DELAY + random.uniform(0, REQUEST_JITTER)) * multiplier
    time.sleep(delay)


def request_with_retry(method, url, **kwargs):
    last_exc = None
    for attempt in range(REQUEST_MAX_RETRY):
        try:
            polite_sleep()
            response = requests.request(method, url, **kwargs)
            if response.status_code == 429 or response.status_code >= 500:
                raise requests.exceptions.HTTPError(
                    f"HTTP {response.status_code}", response=response
                )
            return response
        except requests.exceptions.RequestException as e:
            last_exc = e
            if attempt == REQUEST_MAX_RETRY - 1:
                raise
            polite_sleep(multiplier=BACKOFF_BASE ** (attempt + 1))
    if last_exc:
        raise last_exc

def send_msg(page, law_type):  # 爬取国家法律法规数据库，获取数据
    try:
        url = 'https://flk.npc.gov.cn/law-search/search/list'
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json;charset=UTF-8",
            "Origin": "https://flk.npc.gov.cn",
            "Referer": "https://flk.npc.gov.cn/search",
            "Connection": "keep-alive"
        }
        payload = {
            "searchRange": 1,
            "sxrq": [],
            "gbrq": [],
            "searchType": 2,
            "sxx": [],
            "gbrqYear": [],
            "flfgCodeId": TYPE_TO_FLFG_CODE_IDS[law_type],
            "zdjgCodeId": [],
            "searchContent": "",
            "xgzlSearch": False,
            "orderByParam": {"order": "-1", "sort": ""},
            "pageNum": page,
            "pageSize": 20
        }
        r = request_with_retry('post', url, headers=headers, json=payload, timeout=30)
        status_code = r.status_code
        content_type = r.headers.get('Content-Type', '')
        body_prefix = r.text[:240].replace('\n', ' ')
        r.raise_for_status()
        try:
            law = r.json()
        except json.decoder.JSONDecodeError:
            return {
                '_error': {
                    'page': page,
                    'status_code': status_code,
                    'content_type': content_type,
                    'error': '响应不是合法JSON',
                    'body_prefix': body_prefix
                }
            }
        api_code = law.get('code')
        if api_code is not None and api_code != 200:
            return {
                '_error': {
                    'page': page,
                    'status_code': status_code,
                    'content_type': content_type,
                    'error': f"接口返回异常：code={api_code} msg={law.get('msg')}",
                    'body_prefix': body_prefix
                }
            }
        # 兼容两种结构：
        # 1) {"code":200,"msg":"查询成功","data":{"total":...,"rows":[...]}}
        # 2) {"total":...,"rows":[...]}  （当前线上观测结构）
        data = law.get('data') if isinstance(law.get('data'), dict) else law
        if not isinstance(data, dict) or 'rows' not in data:
            return {
                '_error': {
                    'page': page,
                    'status_code': status_code,
                    'content_type': content_type,
                    'error': f'接口返回结构异常，缺少rows字段，msg={law.get("msg")}',
                    'body_prefix': body_prefix
                }
            }
        return data
    except requests.exceptions.RequestException as e:
        response = getattr(e, 'response', None)
        return {
            '_error': {
                'page': page,
                'status_code': response.status_code if response is not None else None,
                'content_type': response.headers.get('Content-Type', '') if response is not None else '',
                'error': str(e),
                'body_prefix': (response.text[:240].replace('\n', ' ') if response is not None else '')
            }
        }


def print_error_detail(err):
    lines = [
        '接口未返回有效JSON数据（常见原因：反爬限制/IP限流/临时网络异常），请稍后重试或更换IP后重试。',
        '--- 校验详情 ---',
        f"页码：{err.get('page')}",
        f"HTTP状态码：{err.get('status_code')}",
        f"Content-Type：{err.get('content_type')}"
    ]
    if err.get('error'):
        lines.append(f"异常信息：{err.get('error')}")
    if err.get('body_prefix'):
        lines.append(f"响应片段：{err.get('body_prefix')}")
    lines.append('--- 校验详情结束 ---')
    for line in lines:
        print(line)
    with open(ERROR_LOG_PATH, 'a+', encoding='utf-8') as ef:
        ef.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}]\n")
        ef.write('\n'.join(lines))
        ef.write('\n')


def law_index(law, t, begin_no, path3, path4):  # 爬取国家法律法规数据库，将数据储存至本地
    law_list = law.get('rows', [])
    browse_index_file = f'{path4}/{t}-浏览索引.txt'
    added_or_updated = 0
    filenames = os.listdir(f'{path3}')  # 把旧数据导入进来，形成列表，新数据与旧数据比对，名称相同、日期不同/无名称-下载新法
    if '.DS_Store' in filenames:
        filenames.remove('.DS_Store')
    if f'{t}-最新规范.txt' in filenames:
        filenames.remove(f'{t}-最新规范.txt')
    if filenames:
        filename = max(filenames)
        index_file = f'{path3}/{filename}'
        try:
            with open(index_file, encoding='utf-8') as f0:
                ff = f0.read()
        except UnicodeDecodeError:
            # 兼容历史文件可能用系统默认编码（如gbk）保存的情况
            with open(index_file, encoding='gbk', errors='ignore') as f0:
                ff = f0.read()
        regex = re.compile(r"名称.+|"
                           r'公布日期.+')
        old_law_list = regex.findall(ff)
    # 新数据-生成最新法律索引
    with open(f'{path3}/{t}-最新规范.txt', 'a+', encoding='utf-8') as f1:
        for i in range(len(law_list)):
            title = law_list[i]['title']
            office = law_list[i].get('zdjgName', '')
            publish = law_list[i].get('gbrq', '')
            expiry = law_list[i].get('sxrq', '')
            type_ = law_list[i].get('flxz', '')
            sxx = law_list[i].get('sxx')
            status = str(sxx) if sxx is not None else ''
            if status == '2':
                status = '已失效'
            elif status == '3':
                status = '现行有效'
            elif status == '4':
                status = '即将生效'
            else:
                status = f'状态编码{sxx}' if sxx is not None else ''
            url_ = f"https://flk.npc.gov.cn/detail?id={law_list[i].get('bbbs', '')}"
            print(f'''No.{begin_no + i}
名称：{title}
制定机关：{office}
公布日期：{publish}
生效日期：{expiry}
法律性质：{type_}
时效性：{status}
网址：{url_}
''', file=f1)
            # 更新旧数据-法律库
            # 有旧法规索引，旧法修改
            if filenames and f'名称：{title}' in old_law_list:
                n = old_law_list.index(f'名称：{title}')
                old_publish = old_law_list[n + 1][5:]
                publish_cmp = publish if publish else ''
                old_publish_cmp = old_publish if old_publish else ''
                if publish_cmp and old_publish_cmp and publish_cmp > old_publish_cmp:
                    print(f'《{title}》已被{office}修改，新规范公布日期为{publish}。')
                    with open(browse_index_file, 'a+', encoding='utf-8') as f2:
                        print(f'名称：{title}\n链接：{url_}\n', file=f2)
                    added_or_updated += 1
                elif not old_publish_cmp:
                    print(f'《{title}》已存在历史记录但缺少历史公布日期，已加入浏览索引复核。')
                    with open(browse_index_file, 'a+', encoding='utf-8') as f2:
                        print(f'名称：{title}\n链接：{url_}\n', file=f2)
                    added_or_updated += 1
              # else: 仅显示更新规范？
              #     print(f'{office}制定的《{title}》已为最新，公布日期为{publish}。')
            # 有旧法规索引，新制定法
            elif filenames and f'名称：{title}' not in old_law_list:
                print(f'{office}新制定了《{title}》，新规范公布日期为{publish}。')
                with open(browse_index_file, 'a+', encoding='utf-8') as f2:
                    print(f'名称：{title}\n链接：{url_}\n', file=f2)
                added_or_updated += 1
            # 无旧法规索引，建立法规索引库、法律库
            elif not filenames:
                print(f'{office}制定的《{title}》已建立法规索引，该规范公布日期为{publish}。')
                with open(browse_index_file, 'a+', encoding='utf-8') as f2:
                    print(f'名称：{title}\n链接：{url_}\n', file=f2)
                added_or_updated += 1
    # 始终生成当日浏览索引文件，避免后续流程因“无新增”而误判为未产出。
    if not os.path.exists(browse_index_file):
        with open(browse_index_file, 'w', encoding='utf-8') as f2:
            print(f'截至{t}，本次检索未发现新增或更新规范。', file=f2)
    return len(law_list), added_or_updated


def treaty(type, page):  # 爬取条约数据库
    url = f'http://treaty.mfa.gov.cn/Treaty/web/list.jsp?nPageIndex_={page}&keywords=&chnltype_c=all'
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Accept-Language": "zh-CN,zh-Hans;q=0.9",
        "Connection": "keep-alive"
    }
    params = {
        "nPageIndex": f"{page}",
        "chnltype_c": "all"
    }
    r = request_with_retry('get', url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, 'html.parser')
    law = soup.find_all('a', target="_blank")[1:]
    num_link = soup.find('a', text="尾页")['href']
    num = re.findall(r"\d+", num_link)
    num = int(num[0])
    for item in law:  # item为单个条约
        title = item.get_text()
        detail = item['href']
        url_ = 'http://treaty.mfa.gov.cn/web/' + detail
        res = request_with_retry('get', url_, timeout=30)
        res.raise_for_status()
        soup_ = BeautifulSoup(res.text, 'html.parser')
        info = soup_.find_all(name='td')
        if (info[1].text.rstrip() in dic[type]) or (type == 'tiaoyue'):
            if info[1].text.rstrip() in '双边条约':
                treaty_path2 = f'{path}/法规爬虫/条约/双边条约/双边条约库'
                treaty_path3 = f'{path}/法规爬虫/条约/双边条约/法规索引'
                treaty_index(law,treaty_path3, page, item, title, info)
                chance = 5
                while chance >= 0:
                    try:
                        treaty_download(soup_, title, treaty_path2)
                        break
                    except TypeError:
                        chance = chance - 1
                        print(f'{title}  下载失败{5 - chance}次，尝试重新下载……')
                if chance < 0:
                    print(f'{title}  下载失败')

            elif info[1].text.rstrip() in '多边条约':
                treaty_path2 = f'{path}/法规爬虫/条约/多边条约/多边条约库'
                treaty_path3 = f'{path}/法规爬虫/条约/多边条约/法规索引'
                treaty_index(law,treaty_path3, page, item, title, info)
                chance = 5
                while chance >= 0:
                    try:
                        treaty_download(soup_, title, treaty_path2)
                        break
                    except TypeError:
                        chance = chance - 1
                        print(f'{title}  下载失败{5 - chance}次，尝试重新下载……')
                if chance < 0:
                    print(f'{title}  下载失败')
    print(f'第{page}页检索完毕。')
    return num


def treaty_index(law,treaty_path3, page, item, title, info):  # 建立条约索引
    with open(f'{treaty_path3}/{t}-最新规范.txt', 'a+', encoding='utf-8') as f1:
        print(f'{page}-{law.index(item) + 1}.《{title}》', file=f1)
        print(f'{page}-{law.index(item) + 1}.《{title}》已入库！')
        print(re.sub(r'\s+', '', info[0].text) + re.sub(r'\s+', '', info[1].text), file=f1)
        print(re.sub(r'\s+', '', info[2].text) + re.sub(r'\s+', '', info[3].text) + re.sub(r'\s+', '', info[4].text),file=f1)
        info2 = []
        for i in info:
            if i.text == '序号':
                info1 = info[5:info.index(i)]
                info2 = info[info.index(i):]
                break
        else:
            info1 = info[5:]
        for i in range(int(len(info1) / 2)):
            j = info1[2 * i]
            j = re.sub(r'\s+', '', j.text)
            k = info1[2 * i + 1]
            k = re.sub(r'\s+', '', k.text)
            print(j + k, file=f1)
        print('\n', file=f1)
        if info2:
            for i in range(int(len(info2) / 7)):
                if i == 0:
                    print('序号 国家         签署时间    交存行动文书时间    对其生效时间      行动文书      声明保留 ', file=f1)
                else:
                    number = re.sub(r'\s+', '', info2[i * 7].text)
                    number = number.ljust(4, ' ')
                    country_name = re.sub(r'\s+', '', info2[i * 7 + 1].text)
                    country_name = country_name.ljust(10, ' ')
                    sign_date = re.sub(r'\s+', '', info2[i * 7 + 2].text)
                    sign_date = sign_date.ljust(14, ' ')
                    give_date = re.sub(r'\s+', '', info2[i * 7 + 3].text)
                    give_date = give_date.ljust(14, ' ')
                    valid_date = re.sub(r'\s+', '', info2[i * 7 + 4].text)
                    valid_date = valid_date.ljust(14, ' ')
                    action = re.sub(r'\s+', '', info2[i * 7 + 5].text)
                    action = action.ljust(10, ' ')
                    print(number + country_name + sign_date + give_date + valid_date + action + re.sub(r'\s+', '',info2[i * 7 + 6].text) + '  ',file=f1)
            else:
                print('\n', file=f1)


def treaty_download(soup_, title, treaty_path2):  # 下载条约库
    if download_control:
        download_urls = soup_.find_all('a', text="预览")
        for du in download_urls:
            download_url = 'http://treaty.mfa.gov.cn' + du['href']
            responsepdf = request_with_retry('get', download_url, timeout=60)
            if responsepdf.status_code == 200:
                if download_urls.index(du) == 0:
                    with open(f"{treaty_path2}/{title}.pdf", "wb") as code:
                        code.write(responsepdf.content)
                else:
                    with open(f"{treaty_path2}/{title}-{download_urls.index(du)}.pdf", "wb") as code:
                        code.write(responsepdf.content)
                        
# 为防止程序运行时，mac熄屏或者进入屏保，mac电脑可选择取消下行代码的注释（但似乎可能产生bug）；如果您的电脑并非mac，请使用其他避免休眠代码，无须取消下行代码注释。
# caffeinate_process = subprocess.Popen(['caffeinate', '-u'])

type = str(input('''爬取规范类型：
0.xf（宪法）；
1.flfg（法律）；
2.xzfg（行政法规）；
3.sfjs（司法解释）；
4.dfxfg（地方性法规）；
4.1.jcfg（监察法规）；
5.tiaoyue（条约）
5.1.shuangbian（双边条约）；
5.2.duobian（多边条约）
输入拼音：（如flfg）'''))

dic = {'xf': '宪法', 'flfg': '法律', 'xzfg': '行政法规', 'jcfg': '监察法规', 'sfjs': '司法解释', 'dfxfg': '地方法规', 'tiaoyue': '条约', 'shuangbian': '双边条约','duobian': '多边条约'}

path = input('输入数据库所在目录（绝对路径）：')
if type in {'xf', 'flfg', 'xzfg', 'jcfg', 'sfjs', 'dfxfg'}:
    os.makedirs(f'{path}/法规爬虫/{dic[type]}/{dic[type]}库', exist_ok=True)
    os.makedirs(f'{path}/法规爬虫/{dic[type]}/法规索引', exist_ok=True)
    os.makedirs(f'{path}/法规爬虫/{dic[type]}/中间文档', exist_ok=True)
    path2 = f'{path}/法规爬虫/{dic[type]}/{dic[type]}库'
    path3 = f'{path}/法规爬虫/{dic[type]}/法规索引'  # 法规索引库目录（绝对路径）。
    path4 = f'{path}/法规爬虫/{dic[type]}/中间文档'  # 中间文档目录（绝对路径）。

elif type == 'shuangbian':
    os.makedirs(f'{path}/法规爬虫/条约/双边条约/双边条约库', exist_ok=True)
    os.makedirs(f'{path}/法规爬虫/条约/双边条约/法规索引', exist_ok=True)

elif type == 'duobian':
    os.makedirs(f'{path}/法规爬虫/条约/多边条约/多边条约库', exist_ok=True)
    os.makedirs(f'{path}/法规爬虫/条约/多边条约/法规索引', exist_ok=True)

elif type == 'tiaoyue':
    os.makedirs(f'{path}/法规爬虫/条约/双边条约/双边条约库', exist_ok=True)
    os.makedirs(f'{path}/法规爬虫/条约/双边条约/法规索引', exist_ok=True)
    os.makedirs(f'{path}/法规爬虫/条约/多边条约/多边条约库', exist_ok=True)
    os.makedirs(f'{path}/法规爬虫/条约/多边条约/法规索引', exist_ok=True)

t = time.strftime('%Y-%m-%d')

if type in {'xf', 'flfg', 'xzfg', 'jcfg', 'sfjs', 'dfxfg'}:
    last = 0
    try:
        begin_index_file = f'{path3}/{t}-最新规范.txt'
        try:
            with open(begin_index_file, encoding='utf-8') as begin_f:
                begin_file = begin_f.read()
        except UnicodeDecodeError:
            with open(begin_index_file, encoding='gbk', errors='ignore') as begin_f:
                begin_file = begin_f.read()
            regex = re.compile(r"No\.\d+")
            last = regex.findall(begin_file)[-1][3:]
    except FileNotFoundError:
        pass
    e1 = int(input(f'输入起始页：（爬取全库则输入0；爬取全库可能受反爬虫机制限制而出错，出错时请从出错页数[即{int(last)+1}页]起手动爬取，出错页数为法规索引中末尾规范编号+1）'))
    e2 = int(input(f'输入末页：（爬取全库则输入0；不建议超过100页[即{e1+99}页]，如超过100页请分多次爬取；当前仅地方性法规超过100页，其他法规可直接爬取全库）'))
    print('如果第1条就出错，说明当前ip被限制了，须等待一段时间再爬取数据；或者更换ip爬取数据。')
    if e1 + e2 == 0:
        page_range = None
    else:
        page_range = range(e1, e2 + 1)
    l0 = send_msg(1, type)
    if not isinstance(l0, dict) or 'rows' not in l0:
        if isinstance(l0, dict) and '_error' in l0:
            print_error_detail(l0['_error'])
        else:
            print('接口未返回有效JSON数据（常见原因：反爬限制/IP限流/临时网络异常），请稍后重试或更换IP后重试。')
        sys.exit(1)
    total_num = int(l0['total'])
    total_pages = total_num // 20 if total_num % 20 == 0 else total_num // 20 + 1
    if not last:
        with open(f'{path3}/{t}-最新规范.txt', 'w+', encoding='utf-8') as fa:
            print(f'截至{t}，{dic[type]}共{total_num}条，共{total_pages}页。',file=fa)
    if page_range:
        start_page = e1
        end_page = min(e2, total_pages)
        page_range = range(start_page, end_page + 1)
        if e2 > total_pages:
            print(f"输入末页{e2}超过实际总页数{total_pages}，已自动截断为第{end_page}页。")
        print(f"截至{t}，共检索到{dic[type]}{total_num}条，正在检索第{start_page}-{end_page}页……")
    else:
        page_range = range(1, total_pages + 1)
        print(f"截至{t}，共检索到{dic[type]}{total_num}条，正在检索全库……")
    no_counter = 1
    changed_counter = 0
    for page in page_range:
        law = send_msg(page, type)
        if not isinstance(law, dict) or 'rows' not in law:
            print(f'第{page}页返回异常，已中止；请稍后重试。')
            if isinstance(law, dict) and '_error' in law:
                print_error_detail(law['_error'])
            break
        added, changed = law_index(law, t, no_counter, path3, path4)
        no_counter += added
        changed_counter += changed
        print(f'第{page}页已检索，累计{no_counter - 1}条。')
    print(f'本次浏览索引新增/更新条目：{changed_counter}。')
    print('任务完成，感谢使用')

elif type == 'tiaoyue' or type == 'shuangbian' or type == 'duobian':
    page = input('输入起始页数：(默认从第1页开始检索)')
    download_control = input('是否下载？下载则输入非空字符，不下载直接按回车。(下载将拖慢索引建立速度)')
    if not page:
        page = 1
    num = treaty(type, int(page))
    for i in range(int(page), num):
        treaty(type, i + 1)
    print('任务完成，感谢使用')

# 为防止程序运行时，mac熄屏或者进入屏保，mac电脑可选择取消下行代码的注释（但似乎可能产生bug）；如果您的电脑并非mac，请使用其他避免休眠代码，无须取消下行代码注释。
# caffeinate_process.terminate()  
