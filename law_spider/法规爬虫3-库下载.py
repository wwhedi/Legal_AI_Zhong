import os
import random
import re
import sys
import time

import requests

# 避免 Windows/GBK 控制台在打印生僻字时抛出 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    # 某些运行环境可能不支持 reconfigure
    pass

REQUEST_BASE_DELAY = 0.4
REQUEST_JITTER = 0.5
REQUEST_MAX_RETRY = 3
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


law_type = str(input('''爬取规范类型：
0.xf（宪法）；
1.flfg（法律）；
2.xzfg（行政法规）；
3.sfjs（司法解释）；
4.dfxfg（地方法规）；
4.1.jcfg（监察法规）；
输入拼音：（如flfg）'''))

dic = {'xf': '宪法', 'flfg': '法律', 'xzfg': '行政法规', 'jcfg': '监察法规', 'sfjs': '司法解释', 'dfxfg': '地方法规'}

if law_type not in dic:
    print('规范类型输入错误。')
    sys.exit(1)

path = input('输入数据库所在目录（绝对路径）：')
path2 = f'{path}/法规爬虫/{dic[law_type]}/{dic[law_type]}库'
path4 = f'{path}/法规爬虫/{dic[law_type]}/中间文档'
t = time.strftime('%Y-%m-%d')


def parse_download_index(file_path):
    with open(file_path, encoding='utf-8') as f0:
        ff = f0.read()
    blocks = [b.strip() for b in ff.split('\n\n') if b.strip()]
    records = []
    for block in blocks:
        lines = block.splitlines()
        if len(lines) < 4:
            continue
        no_title = lines[0]
        bbbs_line = lines[1]
        format_line = lines[2]
        no_match = re.match(r'(\d+)：(.+)', no_title)
        bbbs_match = re.match(r'bbbs：(.+)', bbbs_line)
        fmt_match = re.match(r'格式：(.+)', format_line)
        if not no_match or not bbbs_match or not fmt_match:
            continue
        records.append({
            'no': int(no_match.group(1)),
            'title': no_match.group(2).strip(),
            'bbbs': bbbs_match.group(1).strip(),
            'format': fmt_match.group(1).strip() or 'docx'
        })
    return records


def fetch_signed_url(bbbs, format_name):
    url = 'https://flk.npc.gov.cn/law-search/download/pc'
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://flk.npc.gov.cn/detail?id={bbbs}"
    }
    params = {'format': format_name, 'bbbs': bbbs}
    r = request_with_retry('get', url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    payload = r.json()
    if payload.get('code') != 200:
        raise ValueError(payload.get('msg', '下载接口返回异常'))
    signed_url = payload.get('data', {}).get('url')
    if not signed_url:
        raise ValueError('下载接口未返回可用URL')
    return signed_url


def safe_filename(name):
    return re.sub(r'[\\/:*?"<>|]', '_', name)


def download_record(record, retry=2):
    ext = '.docx' if record['format'].lower() == 'docx' else f".{record['format'].lower()}"
    filename = f"{record['no']}.{safe_filename(record['title'])}{ext}"
    output_path = os.path.join(path2, filename)
    for attempt in range(retry + 1):
        try:
            signed_url = fetch_signed_url(record['bbbs'], record['format'])
            response = request_with_retry('get', signed_url, timeout=60)
            response.raise_for_status()
            with open(output_path, 'wb') as fp:
                fp.write(response.content)
            print(f"{record['no']}.{record['title']}  已下载！")
            return True
        except Exception as e:
            if attempt == retry:
                print(f"{record['no']}.{record['title']}  下载失败：{e}")
                return False
            polite_sleep(multiplier=BACKOFF_BASE ** (attempt + 1))
    return False


try:
    law_list = parse_download_index(f'{path4}/{t}-下载索引.txt')
except FileNotFoundError:
    print('未找到当日下载索引；请先运行法规爬虫2-建立下载索引.py。')
    sys.exit(1)

if not law_list:
    print('下载索引为空，无需下载。')
    sys.exit(0)

os.makedirs(path2, exist_ok=True)
existing_nos = set()
for fn in os.listdir(path2):
    m = re.match(r'^(\d+)\.', fn)
    if m:
        existing_nos.add(int(m.group(1)))

begin_num = 0
if existing_nos:
    begin_num = max(existing_nos)
    begin_test = input(f'''检测到已下载文件，是否从该文件处继续下载？
--从最大编号处（{begin_num}）继续下载则直接按回车（默认）或输入y；
--从自选编号处继续下载则输入编号（举例来说，如果要下载201,202...则输入200）；
--从头开始下载则输入0；''')
    if not begin_test or begin_test == 'y':
        pass
    else:
        begin_num = int(begin_test)

print('如果长时间无输出，当前ip可能被限制，请更换ip或者稍等一段时间后再次尝试。')
failed = 0
downloaded = 0
for record in law_list:
    if record['no'] <= begin_num:
        continue
    if not download_record(record):
        failed += 1
    else:
        downloaded += 1
        if downloaded % 10 == 0:
            time.sleep(1)
            print('已下载20条，暂停1秒后继续。')

if failed:
    print(f'下载完成，但有{failed}条失败；可重新运行本程序继续。')
else:
    print(f'{dic[law_type]}库下载完毕')
sys.exit(0)
import os
import re
import sys
import time

import requests

law_type = str(input('''爬取规范类型：
0.xf（宪法）；
1.flfg（法律）；
2.xzfg（行政法规）；
3.sfjs（司法解释）；
4.dfxfg（地方法规）；
4.1.jcfg（监察法规）；
输入拼音：（如flfg）'''))

dic = {'xf': '宪法', 'flfg': '法律', 'xzfg': '行政法规', 'jcfg': '监察法规', 'sfjs': '司法解释', 'dfxfg': '地方法规'}

if law_type not in dic:
    print('规范类型输入错误。')
    sys.exit(1)

path = input('输入数据库所在目录（绝对路径）：')
path2 = f'{path}/法规爬虫/{dic[law_type]}/{dic[law_type]}库'
path4 = f'{path}/法规爬虫/{dic[law_type]}/中间文档'
t = time.strftime('%Y-%m-%d')


def parse_download_index(file_path):
    with open(file_path, encoding='utf-8') as f0:
        ff = f0.read()
    blocks = [b.strip() for b in ff.split('\n\n') if b.strip()]
    records = []
    for block in blocks:
        lines = block.splitlines()
        if len(lines) < 4:
            continue
        no_title = lines[0]
        bbbs_line = lines[1]
        format_line = lines[2]
        no_match = re.match(r'(\d+)：(.+)', no_title)
        bbbs_match = re.match(r'bbbs：(.+)', bbbs_line)
        fmt_match = re.match(r'格式：(.+)', format_line)
        if not no_match or not bbbs_match or not fmt_match:
            continue
        records.append({
            'no': int(no_match.group(1)),
            'title': no_match.group(2).strip(),
            'bbbs': bbbs_match.group(1).strip(),
            'format': fmt_match.group(1).strip() or 'docx'
        })
    return records


def fetch_signed_url(bbbs, format_name):
    url = 'https://flk.npc.gov.cn/law-search/download/pc'
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://flk.npc.gov.cn/detail?id={bbbs}"
    }
    params = {'format': format_name, 'bbbs': bbbs}
    r = requests.get(url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    payload = r.json()
    if payload.get('code') != 200:
        raise ValueError(payload.get('msg', '下载接口返回异常'))
    signed_url = payload.get('data', {}).get('url')
    if not signed_url:
        raise ValueError('下载接口未返回可用URL')
    return signed_url


def safe_filename(name):
    return re.sub(r'[\\/:*?"<>|]', '_', name)


def download_record(record, retry=2):
    ext = '.docx' if record['format'].lower() == 'docx' else f".{record['format'].lower()}"
    filename = f"{record['no']}.{safe_filename(record['title'])}{ext}"
    output_path = os.path.join(path2, filename)
    for attempt in range(retry + 1):
        try:
            signed_url = fetch_signed_url(record['bbbs'], record['format'])
            response = requests.get(signed_url, timeout=60)
            response.raise_for_status()
            with open(output_path, 'wb') as fp:
                fp.write(response.content)
            print(f"{record['no']}.{record['title']}  已下载！")
            return True
        except Exception as e:
            if attempt == retry:
                print(f"{record['no']}.{record['title']}  下载失败：{e}")
                return False
            time.sleep(1)
    return False


try:
    law_list = parse_download_index(f'{path4}/{t}-下载索引.txt')
except FileNotFoundError:
    print('未找到当日下载索引；请先运行法规爬虫2-建立下载索引.py。')
    sys.exit(1)

if not law_list:
    print('下载索引为空，无需下载。')
    sys.exit(0)

os.makedirs(path2, exist_ok=True)
existing_nos = set()
for fn in os.listdir(path2):
    m = re.match(r'^(\d+)\.', fn)
    if m:
        existing_nos.add(int(m.group(1)))

begin_num = 0
if existing_nos:
    begin_num = max(existing_nos)
    begin_test = input(f'''检测到已下载文件，是否从该文件处继续下载？
--从最大编号处（{begin_num}）继续下载则输入y；
--从自选编号处继续下载则输入编号（举例来说，如果要下载201,202...则输入200）；
--从头开始下载则直接按回车；''')
    if not begin_test:
        begin_num = 0
    elif begin_test == 'y':
        pass
    else:
        begin_num = int(begin_test)

print('如果长时间无输出，当前ip可能被限制，请更换ip或者稍等一段时间后再次尝试。')
failed = 0
for record in law_list:
    if record['no'] <= begin_num:
        continue
    if not download_record(record):
        failed += 1

if failed:
    print(f'下载完成，但有{failed}条失败；可重新运行本程序继续。')
else:
    print(f'{dic[law_type]}库下载完毕')
import os
import re
import sys
import time

import requests

law_type = str(input('''爬取规范类型：
0.xf（宪法）；
1.flfg（法律）；
2.xzfg（行政法规）；
3.sfjs（司法解释）；
4.dfxfg（地方法规）；
4.1.jcfg（监察法规）；
输入拼音：（如flfg）'''))

dic = {'xf': '宪法', 'flfg': '法律', 'xzfg': '行政法规', 'jcfg': '监察法规', 'sfjs': '司法解释', 'dfxfg': '地方法规'}

if law_type not in dic:
    print('规范类型输入错误。')
    sys.exit(1)

path = input('输入数据库所在目录（绝对路径）：')
path2 = f'{path}/法规爬虫/{dic[law_type]}/{dic[law_type]}库'
path4 = f'{path}/法规爬虫/{dic[law_type]}/中间文档'
t = time.strftime('%Y-%m-%d')


def parse_download_index(file_path):
    with open(file_path, encoding='utf-8') as f0:
        ff = f0.read()
    blocks = [b.strip() for b in ff.split('\n\n') if b.strip()]
    records = []
    for block in blocks:
        lines = block.splitlines()
        if len(lines) < 4:
            continue
        no_title = lines[0]
        bbbs_line = lines[1]
        format_line = lines[2]
        no_match = re.match(r'(\d+)：(.+)', no_title)
        bbbs_match = re.match(r'bbbs：(.+)', bbbs_line)
        fmt_match = re.match(r'格式：(.+)', format_line)
        if not no_match or not bbbs_match or not fmt_match:
            continue
        records.append({
            'no': int(no_match.group(1)),
            'title': no_match.group(2).strip(),
            'bbbs': bbbs_match.group(1).strip(),
            'format': fmt_match.group(1).strip() or 'docx'
        })
    return records


def fetch_signed_url(bbbs, format_name):
    url = 'https://flk.npc.gov.cn/law-search/download/pc'
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://flk.npc.gov.cn/detail?id={bbbs}"
    }
    params = {'format': format_name, 'bbbs': bbbs}
    r = requests.get(url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    payload = r.json()
    if payload.get('code') != 200:
        raise ValueError(payload.get('msg', '下载接口返回异常'))
    signed_url = payload.get('data', {}).get('url')
    if not signed_url:
        raise ValueError('下载接口未返回可用URL')
    return signed_url


def safe_filename(name):
    return re.sub(r'[\\/:*?"<>|]', '_', name)


def download_record(record, retry=2):
    ext = '.docx' if record['format'].lower() == 'docx' else f".{record['format'].lower()}"
    filename = f"{record['no']}.{safe_filename(record['title'])}{ext}"
    output_path = os.path.join(path2, filename)
    for attempt in range(retry + 1):
        try:
            signed_url = fetch_signed_url(record['bbbs'], record['format'])
            response = requests.get(signed_url, timeout=60)
            response.raise_for_status()
            with open(output_path, 'wb') as fp:
                fp.write(response.content)
            print(f"{record['no']}.{record['title']}  已下载！")
            return True
        except Exception as e:
            if attempt == retry:
                print(f"{record['no']}.{record['title']}  下载失败：{e}")
                return False
            time.sleep(1)
    return False


try:
    law_list = parse_download_index(f'{path4}/{t}-下载索引.txt')
except FileNotFoundError:
    print('未找到当日下载索引；请先运行法规爬虫2-建立下载索引.py。')
    sys.exit(1)

if not law_list:
    print('下载索引为空，无需下载。')
    sys.exit(0)

os.makedirs(path2, exist_ok=True)
existing_nos = set()
for fn in os.listdir(path2):
    m = re.match(r'^(\d+)\.', fn)
    if m:
        existing_nos.add(int(m.group(1)))

begin_num = 0
if existing_nos:
    begin_num = max(existing_nos)
    begin_test = input(f'''检测到已下载文件，是否从该文件处继续下载？
--从最大编号处（{begin_num}）继续下载则输入y；
--从自选编号处继续下载则输入编号（举例来说，如果要下载201,202...则输入200）；
--从头开始下载则直接按回车；''')
    if not begin_test:
        begin_num = 0
    elif begin_test == 'y':
        pass
    else:
        begin_num = int(begin_test)

print('如果长时间无输出，当前ip可能被限制，请更换ip或者稍等一段时间后再次尝试。')
failed = 0
for record in law_list:
    if record['no'] <= begin_num:
        continue
    if not download_record(record):
        failed += 1

if failed:
    print(f'下载完成，但有{failed}条失败；可重新运行本程序继续。')
else:
    print(f'{dic[law_type]}库下载完毕')
import os
import re
import sys
import time
import requests
import selenium
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import TimeoutException
from selenium import webdriver
import pypandoc

type = str(input('''爬取规范类型：
1.flfg（法律法规）；
2.xzfg（行政法规）；
3.sfjs（司法解释）；
4.dfxfg（地方性法规）；
输入拼音：（如flfg）'''))

dic = {'flfg': '法律法规', 'xzfg': '行政法规', 'sfjs': '司法解释', 'dfxfg': '地方性法规'}

path = input('输入数据库所在目录（绝对路径）：')
path2 = f'{path}/法规爬虫/{dic[type]}/{dic[type]}库'  # 法律库目录（绝对路径）。
path3 = f'{path}/法规爬虫/{dic[type]}/法规索引'  # 法规索引库目录（绝对路径）。
path4 = f'{path}/法规爬虫/{dic[type]}/中间文档'  # 中间文档目录（绝对路径）。

chrome_options = Options()
chrome_options.add_argument('--headless')
chrome_options.add_argument('--disable-gpu')
prefs = {
    'profile.default_content_settings.popups': 0,
    'download.default_directory': path2,
    'download.prompt_for_download': False,
    'download.directory_upgrade': True,
    'safebrowsing.enabled': True
}
chrome_options.add_experimental_option('prefs', prefs)
# executable_path='/usr/local/bin/chromedriver'
# service = Service(executable_path)
t = time.strftime('%Y-%m-%d')
with open(f'{path4}/{t}-下载索引.txt') as f0:
    ff = f0.read()
regex = re.compile(r"\d+：.+|"
                   r'链接.+')
law_list = regex.findall(ff)

browser = webdriver.Chrome(options=chrome_options)
begin = os.listdir(path2)  # 实现断点续传功能
begin_ = []
for w in begin:
    if w.startswith('._'):
        pass
    elif w == '.DS_Store':
        pass
    else:
        begin_.append(w)
reg = re.compile(r"^\d+\.")
begin_list = [0]
for k in begin_:
    num = reg.match(k)
    if num:
        num = num.group()
        begin_list.append(int(num[:-1]))
    else:
        print(f'发现错误  {k}，正在校正……')
        os.remove(path2 + '/' + k)
begin_num = max(begin_list)
former_num = 0  # 更新数据库--旧数据库法规数量

if begin_num > 0:
    begin_test = input(f'''检测到已下载文件，是否从该文件处继续下载？
-如果您是首次建立库/当日建立库：
--从最大编号处（{begin_num}）继续下载则输入y；
--从自选编号处继续下载则输入编号（举例来说，如果要下载201,202...则输入200）；
--从头开始下载则直接按回车；

-如果您欲更新过去日期建立的库：
--从最大编号处（{begin_num}）继续更新则输入x；
--从自选编号处继续更新则输入x-编号（举例来说，如果要下载201,202...则输入x-200）''')
    if not begin_test:
        begin_num = 0
    elif begin_test == 'y':
        pass
    elif begin_test.startswith('x'):  # 更新数据库，断点续传
        formerlaw = os.listdir(f'{path4}')  # 把旧数据导入进来，形成列表，新数据与旧数据比对
        formerlaw_ = []
        for i in formerlaw:
            if '.DS_Store' in i:
                pass
            elif f'{t}-下载索引.txt' in i:
                pass
            elif '浏览索引' in i:
                pass
            else:
                formerlaw_.append(i)
        if formerlaw_:
            former_law = max(formerlaw_)
            with open(path4 + '/' + former_law) as former:
                former_law_ = former.read()
            former_regex = re.compile(r"\d+：")
            former_law_list = former_regex.findall(former_law_)
            former_num = int(former_law_list[-1][:-1])  # 旧数据--下载的规范数
            if '-' in begin_test:
                begin_num = int(begin_test[2:])
            begin_num = begin_num - former_num
    else:
        begin_num = int(begin_test)
print('如果长时间无输出，当前ip可能被限制，请更换ip或者稍等一段时间后再次尝试。')


def request_downloader(url):  # 下载未提供下载源的文件
    r = requests.get(url)
    r.raise_for_status()
    if r.status_code == 200:
        with open(f"{path2}/{title}.html", "wb") as code:
            code.write(r.content)
    pypandoc.convert_file(f"{path2}/{title}.html", 'docx', outputfile=f"{path2}/{i + 1 + former_num}.{title}.docx")
    os.remove(f"{path2}/{title}.html")
    print(f'{i + 1 + former_num}.{title}  已下载！')


def selenium_downloader(url):  # 下载提供了下载源的文件
    browser.get(url)
    time.sleep(1)
    browser.refresh()  # 可酌情删除提高下载速度
    time.sleep(1)  # 可酌情删除提高下载速度
    url_name = os.path.basename(url)
    chance = 6  # 可酌情减少循环次数提高下载速度，但稳定性会下降，可能受网络波动影响导致下载失败
    while True:
        database = os.listdir(path2)
        for j in database:
            if url_name in j:
                if url_name[-1] == 'x':  # 多数文件以docx格式存储
                    os.rename(f'{path2}/{j}', f'{path2}/{i + 1 + former_num}.{title}.docx')
                elif url_name[-1] == 'c':  # 少数文件以doc格式存储
                    os.rename(f'{path2}/{j}', f'{path2}/{i + 1 + former_num}.{title}.doc')
                elif url_name[-1] == 'C':  # 个别文件以DOC格式存储
                    os.rename(f'{path2}/{j}', f'{path2}/{i + 1 + former_num}.{title}.DOC')
                elif url_name[-1] == 'm':  # 个别文件以docm格式存储
                    os.rename(f'{path2}/{j}', f'{path2}/{i + 1 + former_num}.{title}.docm')
                elif url_name[-1] == 'X':  # 个别文件以DOCX格式存储
                    os.rename(f'{path2}/{j}', f'{path2}/{i + 1 + former_num}.{title}.DOCX')
                elif url_name[-1] == 'F':  # 个别文件以PDF格式存储
                    os.rename(f'{path2}/{j}', f'{path2}/{i + 1 + former_num}.{title}.PDF')
                elif url_name[-1] == 'f':  # 个别文件以pdf格式存储
                    os.rename(f'{path2}/{j}', f'{path2}/{i + 1 + former_num}.{title}.pdf')
                print(f'{i + 1 + former_num}.{title}  已下载！')
                break

        else:
            if chance >= 0:
                time.sleep(1)
                chance = chance - 1
                continue
            else:
                if url[-1] == 'x':  # 少数文件以doc格式存储
                    new_url = url[:-1]
                    selenium_downloader(new_url)
                    break
                elif url[-1] == 'c':  # 个别文件以DOC格式存储
                    new_url = url[:-3] + 'DOC'
                    selenium_downloader(new_url)
                    break
                elif url[-1] == 'C':  # 个别文件以docm格式存储
                    new_url = url[:-3] + 'docm'
                    selenium_downloader(new_url)
                elif url[-1] == 'm':  # 个别文件以DOCX格式存储
                    new_url = url[:-4] + 'DOCX'
                    selenium_downloader(new_url)
                elif url[-1] == 'X':  # 个别文件以PDF格式存储
                    url = re.sub('/WORD/','/PDF/',url)
                    new_url = url[:-4] + 'PDF'
                    selenium_downloader(new_url)
                elif url[-1] == 'F':  # 个别文件以pdf格式存储
                    new_url = url[:-3] + 'pdf'
                    selenium_downloader(new_url)
                else:
                    print(f'{i + 1 + former_num}.{title}  下载失败')
                    print('数据源格式未支持，请自行下载该条文；或者当前ip可能被限制，请更换ip或者稍等一段时间后再次尝试；或者网络不稳定，可再次尝试')
                    sys.exit()
        break


for i in range(begin_num, int(len(law_list) / 2)):  # begin_num实现断点续传功能
    title = re.sub(r'\d+：', '', law_list[2 * i])
    url = law_list[2 * i + 1][3:]
    try:
        if f'https://wb.flk.npc.gov.cn/{type}/texthtml' in url:  # 下载未提供下载源的文件
            request_downloader(url)

        elif f'https://wb.flk.npc.gov.cn/{type}/WORD' in url:  # 下载提供了下载源的文件
            selenium_downloader(url)

    except selenium.common.exceptions.TimeoutException or TimeoutError:
        print(f'{law_list[2 * i]}下载失败')
        print('当前ip可能被限制，请更换ip或者稍等一段时间后再次尝试。')
        sys.exit()
else:
    print(f'{dic[type]}库下载完毕')
# 以下为校验错误代码
print('校正错误中，请稍后……')
outcome = os.listdir(path2)
regex_ = re.compile(r"^\d+\.")
regex__ = re.compile(r'\d+：')
for h in outcome:
    if h == '.DS_Store' or h.startswith('._'):
        pass
    elif regex_.match(h):
        pass
    else:
        print(f'发现错误  {h}，正在校正……')
        os.remove(path2 + '/' + h)

for i in range(int(len(law_list) / 2)):
    no = regex__.findall(law_list[2 * i])[0][:-1]
    no = int(no) + former_num
    for h in outcome:
        if h == '.DS_Store' or h.startswith('._'):
            pass
        elif regex_.match(h):
            no_ = regex_.match(h).group()
            if no_[:-1] == str(no):
                break
        else:
            print(f'发现错误  {h}，正在校正……')
            os.remove(path2 + '/' + h)
    else:
        print(f'{law_list[2 * i]}未下载，正在下载……')
        title = re.sub(r'\d+：', '', law_list[2 * i])
        url = law_list[2 * i + 1][3:]
        try:
            if f'https://wb.flk.npc.gov.cn/{type}/texthtml' in url:  # 下载未提供下载源的文件
                request_downloader(url)

            elif f'https://wb.flk.npc.gov.cn/{type}/WORD' in url:  # 下载提供了下载源的文件
                selenium_downloader(url)

        except selenium.common.exceptions.TimeoutException or TimeoutError:
            print(f'{law_list[2 * i]}下载失败')
            print('当前ip可能被限制，请更换ip或者稍等一段时间后再次尝试。')
            sys.exit()

print('校正完毕，感谢使用；如仍有下载错误，可能是下载索引出错，请先运行法规爬虫2-校验错误.py，确保下载索引无误后再运行本脚本。')
