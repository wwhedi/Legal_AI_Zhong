import re
import sys
import time
import random

import requests

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
path4 = f'{path}/法规爬虫/{dic[law_type]}/中间文档'
t = time.strftime('%Y-%m-%d')
index_path = f'{path4}/{t}-下载索引.txt'


def parse_records(file_path):
    with open(file_path, encoding='utf-8') as f:
        content = f.read()
    blocks = [b.strip() for b in content.split('\n\n') if b.strip()]
    parsed = []
    for block in blocks:
        lines = block.splitlines()
        if len(lines) < 4:
            continue
        title_m = re.match(r'(\d+)：(.+)', lines[0])
        bbbs_m = re.match(r'bbbs：(.+)', lines[1])
        fmt_m = re.match(r'格式：(.+)', lines[2])
        link_m = re.match(r'链接：(.*)', lines[3])
        if not title_m or not bbbs_m or not fmt_m or not link_m:
            continue
        parsed.append({
            'no': int(title_m.group(1)),
            'title': title_m.group(2).strip(),
            'bbbs': bbbs_m.group(1).strip(),
            'format': (fmt_m.group(1).strip() or 'docx'),
            'link': link_m.group(1).strip()
        })
    return parsed


def fetch_signed_url(bbbs, fmt):
    url = 'https://flk.npc.gov.cn/law-search/download/pc'
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://flk.npc.gov.cn/detail?id={bbbs}"
    }
    r = request_with_retry('get', url, headers=headers, params={'format': fmt, 'bbbs': bbbs}, timeout=30)
    r.raise_for_status()
    payload = r.json()
    if payload.get('code') != 200:
        raise ValueError(payload.get('msg', '下载接口返回异常'))
    signed_url = payload.get('data', {}).get('url', '')
    if not signed_url:
        raise ValueError('下载接口未返回可用URL')
    return signed_url


try:
    records = parse_records(index_path)
except FileNotFoundError:
    print('未找到当日下载索引；请先运行法规爬虫2-建立下载索引.py。')
    sys.exit(1)

if not records:
    print('下载索引为空或格式异常，无需校验。')
    sys.exit(0)

print('正在校验错误，请稍后……')
fixed = 0
failed = 0
for rec in records:
    need_refresh = (not rec['link']) or ('X-Amz-Expires=' not in rec['link'])
    if not need_refresh:
        try:
            head = request_with_retry('head', rec['link'], timeout=15, allow_redirects=True)
            if head.status_code >= 400:
                need_refresh = True
        except requests.RequestException:
            need_refresh = True
    if need_refresh:
        try:
            rec['link'] = fetch_signed_url(rec['bbbs'], rec['format'])
            fixed += 1
            print(f"{rec['no']}：《{rec['title']}》已校正下载链接。")
        except Exception as e:
            failed += 1
            print(f"{rec['no']}：《{rec['title']}》校正失败：{e}")

with open(index_path, 'w', encoding='utf-8') as f:
    for rec in records:
        print(f"{rec['no']}：{rec['title']}", file=f)
        print(f"bbbs：{rec['bbbs']}", file=f)
        print(f"格式：{rec['format']}", file=f)
        print(f"链接：{rec['link']}\n", file=f)

print(f'本次校正完毕：已校正{fixed}条，失败{failed}条。')
