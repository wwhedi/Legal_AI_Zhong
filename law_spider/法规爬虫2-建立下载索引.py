import os
import random
import re
import sys
import time
from urllib.parse import parse_qs, urlparse

import requests

# 避免 Windows/GBK 控制台在打印生僻字时抛出 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    # 某些运行环境可能不支持 reconfigure
    pass

TYPE_TO_FORMAT = {
    'xf': 'docx',
    'flfg': 'docx',
    'xzfg': 'docx',
    'jcfg': 'docx',
    'sfjs': 'docx',
    'dfxfg': 'docx'
}

REQUEST_BASE_DELAY=0.5
REQUEST_JITTER=0.5
REQUEST_MAX_RETRY=3
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
                raise requests.exceptions.HTTPError(f"HTTP {response.status_code}", response=response)
            return response
        except requests.exceptions.RequestException as e:
            last_exc = e
            if attempt == REQUEST_MAX_RETRY - 1:
                raise
            polite_sleep(multiplier=BACKOFF_BASE ** (attempt + 1))
    if last_exc:
        raise last_exc


def parse_browse_index(file_path):
    with open(file_path, encoding='utf-8') as f0:
        ff = f0.read()
    titles = re.findall(r'名称：(.+)', ff)
    links = re.findall(r'链接：(.+)', ff)
    if len(titles) != len(links):
        print('浏览索引格式异常（标题与链接数量不一致）。')
        sys.exit(1)
    items = []
    for title, link in zip(titles, links):
        query = parse_qs(urlparse(link).query)
        bbbs = query.get('id', [''])[0]
        if not bbbs:
            print(f'未从链接解析到bbbs：{link}')
            continue
        items.append({'title': title, 'bbbs': bbbs})
    return items


def fetch_download_link(bbbs, format_name):
    url = 'https://flk.npc.gov.cn/law-search/download/pc'
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://flk.npc.gov.cn/detail?id={bbbs}"
    }
    params = {'format': format_name, 'bbbs': bbbs}
    r = request_with_retry('get', url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    if data.get('code') != 200:
        raise ValueError(data.get('msg', '下载接口返回异常'))
    return data.get('data', {}).get('url', '')


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

today_browse = f'{path4}/{t}-浏览索引.txt'
if os.path.exists(today_browse):
    browse_path = today_browse
else:
    candidates = [fn for fn in os.listdir(path4) if fn.endswith('-浏览索引.txt')]
    if not candidates:
        print('未找到浏览索引；请确保目录输入正确，且已运行法规爬虫1生成浏览索引。')
        sys.exit(1)
    candidates.sort()
    browse_path = os.path.join(path4, candidates[-1])
    print(f'未找到当日浏览索引，已回退使用：{candidates[-1]}')

records = parse_browse_index(browse_path)

if not records:
    print('浏览索引为空，无需建立下载索引。')
    sys.exit(0)

format_name = TYPE_TO_FORMAT[law_type]
output_file = f'{path4}/{t}-下载索引.txt'
with open(output_file, 'w', encoding='utf-8') as f:
    for i, item in enumerate(records, start=1):
        title = item['title']
        bbbs = item['bbbs']
        try:
            signed_url = fetch_download_link(bbbs, format_name)
            print(f'{i}：《{title}》已建立下载索引！')
        except Exception as e:
            signed_url = ''
            print(f'{i}：《{title}》建立下载索引失败：{e}')
        print(f'{i}：{title}', file=f)
        print(f'bbbs：{bbbs}', file=f)
        print(f'格式：{format_name}', file=f)
        print(f'链接：{signed_url}\n', file=f)

print(f'{dic[law_type]}已建立下载索引！')
sys.exit(0)
import random
import re
import sys
import time
from urllib.parse import parse_qs, urlparse

import requests

TYPE_TO_FORMAT = {
    'xf': 'docx',
    'flfg': 'docx',
    'xzfg': 'docx',
    'jcfg': 'docx',
    'sfjs': 'docx',
    'dfxfg': 'docx'
}

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
                raise requests.exceptions.HTTPError(f"HTTP {response.status_code}", response=response)
            return response
        except requests.exceptions.RequestException as e:
            last_exc = e
            if attempt == REQUEST_MAX_RETRY - 1:
                raise
            polite_sleep(multiplier=BACKOFF_BASE ** (attempt + 1))
    if last_exc:
        raise last_exc


def parse_browse_index(file_path):
    with open(file_path, encoding='utf-8') as f0:
        ff = f0.read()
    titles = re.findall(r'名称：(.+)', ff)
    links = re.findall(r'链接：(.+)', ff)
    if len(titles) != len(links):
        print('浏览索引格式异常（标题与链接数量不一致）。')
        sys.exit(1)
    items = []
    for title, link in zip(titles, links):
        query = parse_qs(urlparse(link).query)
        bbbs = query.get('id', [''])[0]
        if not bbbs:
            print(f'未从链接解析到bbbs：{link}')
            continue
        items.append({'title': title, 'bbbs': bbbs})
    return items


def fetch_download_link(bbbs, format_name):
    url = 'https://flk.npc.gov.cn/law-search/download/pc'
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://flk.npc.gov.cn/detail?id={bbbs}"
    }
    params = {'format': format_name, 'bbbs': bbbs}
    r = request_with_retry('get', url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    if data.get('code') != 200:
        raise ValueError(data.get('msg', '下载接口返回异常'))
    return data.get('data', {}).get('url', '')


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

try:
    records = parse_browse_index(f'{path4}/{t}-浏览索引.txt')
except FileNotFoundError:
    print('未找到当日浏览索引；请确保目录输入正确，且当日已运行法规爬虫1。')
    sys.exit(1)

if not records:
    print('浏览索引为空，无需建立下载索引。')
    sys.exit(0)

format_name = TYPE_TO_FORMAT[law_type]
output_file = f'{path4}/{t}-下载索引.txt'
with open(output_file, 'w', encoding='utf-8') as f:
    for i, item in enumerate(records, start=1):
        title = item['title']
        bbbs = item['bbbs']
        try:
            signed_url = fetch_download_link(bbbs, format_name)
            print(f'{i}：《{title}》已建立下载索引！')
        except Exception as e:
            signed_url = ''
            print(f'{i}：《{title}》建立下载索引失败：{e}')
        print(f'{i}：{title}', file=f)
        print(f'bbbs：{bbbs}', file=f)
        print(f'格式：{format_name}', file=f)
        print(f'链接：{signed_url}\n', file=f)

print(f'{dic[law_type]}已建立下载索引！')
import random
import re
import sys
import time
from urllib.parse import parse_qs, urlparse

import requests

TYPE_TO_FORMAT = {
    'xf': 'docx',
    'flfg': 'docx',
    'xzfg': 'docx',
    'jcfg': 'docx',
    'sfjs': 'docx',
    'dfxfg': 'docx'
}

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
                raise requests.exceptions.HTTPError(f"HTTP {response.status_code}", response=response)
            return response
        except requests.exceptions.RequestException as e:
            last_exc = e
            if attempt == REQUEST_MAX_RETRY - 1:
                raise
            polite_sleep(multiplier=BACKOFF_BASE ** (attempt + 1))
    if last_exc:
        raise last_exc


def parse_browse_index(file_path):
    with open(file_path, encoding='utf-8') as f0:
        ff = f0.read()
    titles = re.findall(r'名称：(.+)', ff)
    links = re.findall(r'链接：(.+)', ff)
    if len(titles) != len(links):
        print('浏览索引格式异常（标题与链接数量不一致）。')
        sys.exit(1)
    items = []
    for title, link in zip(titles, links):
        query = parse_qs(urlparse(link).query)
        bbbs = query.get('id', [''])[0]
        if not bbbs:
            print(f'未从链接解析到bbbs：{link}')
            continue
        items.append({'title': title, 'bbbs': bbbs})
    return items


def fetch_download_link(bbbs, format_name):
    url = 'https://flk.npc.gov.cn/law-search/download/pc'
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://flk.npc.gov.cn/detail?id={bbbs}"
    }
    params = {'format': format_name, 'bbbs': bbbs}
    r = request_with_retry('get', url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    if data.get('code') != 200:
        raise ValueError(data.get('msg', '下载接口返回异常'))
    return data.get('data', {}).get('url', '')


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

try:
    records = parse_browse_index(f'{path4}/{t}-浏览索引.txt')
except FileNotFoundError:
    print('未找到当日浏览索引；请确保目录输入正确，且当日已运行法规爬虫1。')
    sys.exit(1)

if not records:
    print('浏览索引为空，无需建立下载索引。')
    sys.exit(0)

format_name = TYPE_TO_FORMAT[law_type]
output_file = f'{path4}/{t}-下载索引.txt'
with open(output_file, 'w', encoding='utf-8') as f:
    for i, item in enumerate(records, start=1):
        title = item['title']
        bbbs = item['bbbs']
        try:
            signed_url = fetch_download_link(bbbs, format_name)
            print(f'{i}：《{title}》已建立下载索引！')
        except Exception as e:
            signed_url = ''
            print(f'{i}：《{title}》建立下载索引失败：{e}')
        print(f'{i}：{title}', file=f)
        print(f'bbbs：{bbbs}', file=f)
        print(f'格式：{format_name}', file=f)
        print(f'链接：{signed_url}\n', file=f)

print(f'{dic[law_type]}已建立下载索引！')
import random
import re
import sys
import time
from urllib.parse import parse_qs, urlparse

import requests

TYPE_TO_FORMAT = {
    'xf': 'docx',
    'flfg': 'docx',
    'xzfg': 'docx',
    'jcfg': 'docx',
    'sfjs': 'docx',
    'dfxfg': 'docx'
}

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
                raise requests.exceptions.HTTPError(f"HTTP {response.status_code}", response=response)
            return response
        except requests.exceptions.RequestException as e:
            last_exc = e
            if attempt == REQUEST_MAX_RETRY - 1:
                raise
            polite_sleep(multiplier=BACKOFF_BASE ** (attempt + 1))
    if last_exc:
        raise last_exc


def parse_browse_index(file_path):
    with open(file_path, encoding='utf-8') as f0:
        ff = f0.read()
    titles = re.findall(r'名称：(.+)', ff)
    links = re.findall(r'链接：(.+)', ff)
    if len(titles) != len(links):
        print('浏览索引格式异常（标题与链接数量不一致）。')
        sys.exit(1)
    items = []
    for title, link in zip(titles, links):
        query = parse_qs(urlparse(link).query)
        bbbs = query.get('id', [''])[0]
        if not bbbs:
            print(f'未从链接解析到bbbs：{link}')
            continue
        items.append({'title': title, 'bbbs': bbbs})
    return items


def fetch_download_link(bbbs, format_name):
    url = 'https://flk.npc.gov.cn/law-search/download/pc'
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://flk.npc.gov.cn/detail?id={bbbs}"
    }
    params = {'format': format_name, 'bbbs': bbbs}
    r = request_with_retry('get', url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    if data.get('code') != 200:
        raise ValueError(data.get('msg', '下载接口返回异常'))
    return data.get('data', {}).get('url', '')


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

try:
    records = parse_browse_index(f'{path4}/{t}-浏览索引.txt')
except FileNotFoundError:
    print('未找到当日浏览索引；请确保目录输入正确，且当日已运行法规爬虫1。')
    sys.exit(1)

if not records:
    print('浏览索引为空，无需建立下载索引。')
    sys.exit(0)

format_name = TYPE_TO_FORMAT[law_type]
output_file = f'{path4}/{t}-下载索引.txt'
with open(output_file, 'w', encoding='utf-8') as f:
    for i, item in enumerate(records, start=1):
        title = item['title']
        bbbs = item['bbbs']
        try:
            signed_url = fetch_download_link(bbbs, format_name)
            print(f'{i}：《{title}》已建立下载索引！')
        except Exception as e:
            signed_url = ''
            print(f'{i}：《{title}》建立下载索引失败：{e}')
        print(f'{i}：{title}', file=f)
        print(f'bbbs：{bbbs}', file=f)
        print(f'格式：{format_name}', file=f)
        print(f'链接：{signed_url}\n', file=f)

print(f'{dic[law_type]}已建立下载索引！')
import random
import re
import sys
import time
from urllib.parse import parse_qs, urlparse

import requests

TYPE_TO_FORMAT = {
    'xf': 'docx',
    'flfg': 'docx',
    'xzfg': 'docx',
    'jcfg': 'docx',
    'sfjs': 'docx',
    'dfxfg': 'docx'
}

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


def parse_browse_index(file_path):
    with open(file_path, encoding='utf-8') as f0:
        ff = f0.read()
    titles = re.findall(r'名称：(.+)', ff)
    links = re.findall(r'链接：(.+)', ff)
    if len(titles) != len(links):
        print('浏览索引格式异常（标题与链接数量不一致）。')
        sys.exit(1)
    items = []
    for title, link in zip(titles, links):
        query = parse_qs(urlparse(link).query)
        bbbs = query.get('id', [''])[0]
        if not bbbs:
            print(f'未从链接解析到bbbs：{link}')
            continue
        items.append({'title': title, 'bbbs': bbbs})
    return items


def fetch_download_link(bbbs, format_name):
    url = 'https://flk.npc.gov.cn/law-search/download/pc'
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://flk.npc.gov.cn/detail?id={bbbs}"
    }
    params = {'format': format_name, 'bbbs': bbbs}
    r = request_with_retry('get', url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    if data.get('code') != 200:
        raise ValueError(data.get('msg', '下载接口返回异常'))
    return data.get('data', {}).get('url', '')


try:
    records = parse_browse_index(f'{path4}/{t}-浏览索引.txt')
except FileNotFoundError:
    print('未找到当日浏览索引；请确保目录输入正确，且当日已运行法规爬虫1。')
    sys.exit(1)

if not records:
    print('浏览索引为空，无需建立下载索引。')
    sys.exit(0)

format_name = TYPE_TO_FORMAT[law_type]
output_file = f'{path4}/{t}-下载索引.txt'
with open(output_file, 'w', encoding='utf-8') as f:
    for i, item in enumerate(records, start=1):
        title = item['title']
        bbbs = item['bbbs']
        try:
            signed_url = fetch_download_link(bbbs, format_name)
            print(f'{i}：《{title}》已建立下载索引！')
        except Exception as e:
            signed_url = ''
            print(f'{i}：《{title}》建立下载索引失败：{e}')
        print(f'{i}：{title}', file=f)
        print(f'bbbs：{bbbs}', file=f)
        print(f'格式：{format_name}', file=f)
        print(f'链接：{signed_url}\n', file=f)

print(f'{dic[law_type]}已建立下载索引！')
import re
import sys
import time
from urllib.parse import parse_qs, urlparse

import requests

TYPE_TO_FORMAT = {
    'xf': 'docx',
    'flfg': 'docx',
    'xzfg': 'docx',
    'jcfg': 'docx',
    'sfjs': 'docx',
    'dfxfg': 'docx'
}

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


def parse_browse_index(file_path):
    with open(file_path, encoding='utf-8') as f0:
        ff = f0.read()
    titles = re.findall(r'名称：(.+)', ff)
    links = re.findall(r'链接：(.+)', ff)
    if len(titles) != len(links):
        print('浏览索引格式异常（标题与链接数量不一致）。')
        sys.exit(1)
    items = []
    for title, link in zip(titles, links):
        query = parse_qs(urlparse(link).query)
        bbbs = query.get('id', [''])[0]
        if not bbbs:
            print(f'未从链接解析到bbbs：{link}')
            continue
        items.append({'title': title, 'bbbs': bbbs})
    return items


def fetch_download_link(bbbs, format_name):
    url = 'https://flk.npc.gov.cn/law-search/download/pc'
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://flk.npc.gov.cn/detail?id={bbbs}"
    }
    params = {'format': format_name, 'bbbs': bbbs}
    r = requests.get(url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    if data.get('code') != 200:
        raise ValueError(data.get('msg', '下载接口返回异常'))
    return data.get('data', {}).get('url', '')


try:
    records = parse_browse_index(f'{path4}/{t}-浏览索引.txt')
except FileNotFoundError:
    print('未找到当日浏览索引；请确保目录输入正确，且当日已运行法规爬虫1。')
    sys.exit(1)

if not records:
    print('浏览索引为空，无需建立下载索引。')
    sys.exit(0)

format_name = TYPE_TO_FORMAT[law_type]
output_file = f'{path4}/{t}-下载索引.txt'
with open(output_file, 'w', encoding='utf-8') as f:
    for i, item in enumerate(records, start=1):
        title = item['title']
        bbbs = item['bbbs']
        try:
            signed_url = fetch_download_link(bbbs, format_name)
            print(f'{i}：《{title}》已建立下载索引！')
        except Exception as e:
            signed_url = ''
            print(f'{i}：《{title}》建立下载索引失败：{e}')
        print(f'{i}：{title}', file=f)
        print(f'bbbs：{bbbs}', file=f)
        print(f'格式：{format_name}', file=f)
        print(f'链接：{signed_url}\n', file=f)

print(f'{dic[law_type]}已建立下载索引！')
import os
import re
import sys
import time
from urllib.parse import parse_qs, urlparse

import requests

TYPE_TO_FORMAT = {
    'xf': 'docx',
    'flfg': 'docx',
    'xzfg': 'docx',
    'jcfg': 'docx',
    'sfjs': 'docx',
    'dfxfg': 'docx'
}

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


def parse_browse_index(file_path):
    with open(file_path, encoding='utf-8') as f0:
        ff = f0.read()
    titles = re.findall(r'名称：(.+)', ff)
    links = re.findall(r'链接：(.+)', ff)
    if len(titles) != len(links):
        print('浏览索引格式异常（标题与链接数量不一致）。')
        sys.exit(1)
    items = []
    for title, link in zip(titles, links):
        query = parse_qs(urlparse(link).query)
        bbbs = query.get('id', [''])[0]
        if not bbbs:
            print(f'未从链接解析到bbbs：{link}')
            continue
        items.append({'title': title, 'bbbs': bbbs})
    return items


def fetch_download_link(bbbs, format_name):
    url = 'https://flk.npc.gov.cn/law-search/download/pc'
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://flk.npc.gov.cn/detail?id={bbbs}"
    }
    params = {'format': format_name, 'bbbs': bbbs}
    r = requests.get(url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    if data.get('code') != 200:
        raise ValueError(data.get('msg', '下载接口返回异常'))
    return data.get('data', {}).get('url', '')


try:
    records = parse_browse_index(f'{path4}/{t}-浏览索引.txt')
except FileNotFoundError:
    print('未找到当日浏览索引；请确保目录输入正确，且当日已运行法规爬虫1。')
    sys.exit(1)

if not records:
    print('浏览索引为空，无需建立下载索引。')
    sys.exit(0)

format_name = TYPE_TO_FORMAT[law_type]
output_file = f'{path4}/{t}-下载索引.txt'
with open(output_file, 'w', encoding='utf-8') as f:
    for i, item in enumerate(records, start=1):
        title = item['title']
        bbbs = item['bbbs']
        try:
            signed_url = fetch_download_link(bbbs, format_name)
            print(f'{i}：《{title}》已建立下载索引！')
        except Exception as e:
            signed_url = ''
            print(f'{i}：《{title}》建立下载索引失败：{e}')
        print(f'{i}：{title}', file=f)
        print(f'bbbs：{bbbs}', file=f)
        print(f'格式：{format_name}', file=f)
        print(f'链接：{signed_url}\n', file=f)

print(f'{dic[law_type]}已建立下载索引！')
import os
import sys
import time
import re
import selenium
from selenium.webdriver.chrome.options import Options
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException

# 规范类型与此前建立法规索引、浏览索引的法规一致。

type = str(input('''爬取规范类型：
1.flfg（法律法规）；
2.xzfg（行政法规）；
3.sfjs（司法解释）；
4.dfxfg（地方性法规）；
输入拼音：（如flfg）'''))

dic = {'flfg': '法律法规', 'xzfg': '行政法规', 'sfjs': '司法解释', 'dfxfg': '地方性法规'}

path = input('输入数据库所在目录（绝对路径）：')
path2 = f'{path}/法规爬虫/{dic[type]}/{dic[type]}库'  # 法律库目录（绝对路径）。
path4 = f'{path}/法规爬虫/{dic[type]}/中间文档'  # 中间文档目录（绝对路径）。

t = time.strftime('%Y-%m-%d')

try:
    with open(f'{path4}/{t}-浏览索引.txt') as f0:
        ff = f0.read()
    regex = re.compile(r"名称.+|"
                       r'链接.+')
    law_list = regex.findall(ff)
except FileNotFoundError:
    print('未找到当日浏览索引；请确保目录输入正确，且当日已运行法规爬虫1、建立浏览索引；如果您想使用已有的浏览索引，请将其命名为当日日期。')
    # caffeinate_process.terminate()
    sys.exit()

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
# executable_path='/usr/local/bin/chromedriver' # 请确保您的chromedriver内核与chrome浏览器兼容；请确保此处executable_path为您的chromedriver路径
# service = Service(executable_path) # selenium 4.22 版本中，不必使用service参数
no = 0

browser = webdriver.Chrome(options=chrome_options)
print('首次运行程序可能会有一段启动时间。')
print("程序运行过程中会出现一段时间内无输出现象，此为程序写入过程，无须特别关注。")
print('但如果程序长时间无输出，或者报错TimeoutException，当前ip可能被限制，请更换ip或者稍等一段时间后再次尝试。')
print('下载索引建立完毕后，程序将自动校验已建立的下载索引中的错误；如果您已建立了部分下载索引，可手动运行法规爬虫2-校验其错误。')


def download_index(no):
    for i in range(no, int(len(law_list) / 2)):
        title = law_list[2 * i][3:]
        url = law_list[2 * i + 1][3:]
        browser.get(url)
        codeMa = WebDriverWait(browser, 20, 0.5).until(EC.presence_of_element_located((By.ID, 'codeMa')))
        png = codeMa.get_attribute('src')
        png = re.sub(r'PNG', 'WORD', png)
        if f'//{type}' in png:  # 有的文件，国家法律法规数据库提供的链接有错误
            png = re.sub(rf'//{type}', f'/{type}', png)
        doc = re.sub(r'\.png', '.docx', png)
        if 'images/qr' in doc:  # 有的文件未提供下载源
            file = browser.find_element(By.ID,"viewDoc")
            doc = file.get_attribute("src")
        print(f'{i + 1}：{title}', file=f)
        print(f'链接：{doc}\n', file=f)
        print(f'{i + 1}：《{title}》已建立下载索引！')


try:
    with open(f'{path4}/{t}-下载索引.txt', 'r') as f:
        fff = f.read()
        regex = re.compile(r"\d+：")
        last = regex.findall(fff)[-1]
        no = int(last[:-1])
        regex = re.compile(r"\d+：|"
                           r'链接.+')
        l_list = regex.findall(fff)
        if not re.match(r'链接.+', l_list[-1]):  # 有时由于网络波动或者不当关闭程序，下载断点处没有获取到下载链接
            title = l_list[-1][:-1] + '.' + law_list[no*2][3:]
            print(f'{title}未建立下载链接，正在校正……')
            u = law_list[no*2+1][3:]
            browser.get(u)
            codeMa = WebDriverWait(browser, 20, 0.5).until(EC.presence_of_element_located((By.ID, 'codeMa')))
            png = codeMa.get_attribute('src')
            png = re.sub(r'PNG', 'WORD', png)
            if f'//{type}' in png:  # 有的文件，国家法律法规数据库提供的链接有错误
                png = re.sub(rf'//{type}', f'/{type}', png)
            doc = re.sub(r'\.png', '.docx', png)
            if 'images/qr' in doc:  # 有的文件未提供下载源
                file = browser.find_element(By.ID,"viewDoc")
                doc = file.get_attribute("src")
    with open(f'{path4}/{t}-下载索引.txt', 'a+', encoding='utf-8') as f:
        if not re.match(r'链接.+', l_list[-1]):
            print(f'链接：{doc}\n', file=f)
            print(f'{title}已建立下载链接！')
        download_index(no)
    print(f'{dic[type]}已建立下载索引！')
except FileNotFoundError:
    with open(f'{path4}/{t}-下载索引.txt', 'a+', encoding='utf-8') as f:
        download_index(no)
    print(f'{dic[type]}已建立下载索引！')

except IndexError:
    with open(f'{path4}/{t}-下载索引.txt', 'a+', encoding='utf-8') as f:
        download_index(no)
    print(f'{dic[type]}已建立下载索引！')

except selenium.common.exceptions.TimeoutException:
    print('链接超时，当前ip可能被限制，请更换ip或者稍等一段时间后再次尝试；请注意，如您需要运行法规爬虫3-库下载.py，请先确保已建立的下载索引正确无误（可运行法规爬虫2-检验错误.py校正错误）；由于反爬虫机制限制，您可能需要等一段时间或者更换ip运行法规爬虫2-检验错误.py')

# 以下为检验错误代码
print('正在校验错误，请稍后……')
f3 = ''
with open(f'{path4}/{t}-下载索引.txt', 'r') as f1:
    f2 = f1.read()
    regex = re.compile(r"\d+：|"
                       r'链接.+')
    l_list = regex.findall(f2)

if not re.match(r'链接.+', l_list[-1]):  # 有时由于网络波动或者不当关闭程序，下载断点处没有获取到下载链接
    no = int(l_list[-1][:-1]) - 1
    title = l_list[-1][:-1] + '.' + law_list[no*2][3:]
    print(f'{title}未建立下载链接，正在校正……')
    u = law_list[no*2+1][3:]
    try:
        browser.get(u)
        codeMa = WebDriverWait(browser, 20, 0.5).until(EC.presence_of_element_located((By.ID, 'codeMa')))
        png = codeMa.get_attribute('src')
        png = re.sub(r'PNG', 'WORD', png)
        if f'//{type}' in png:  # 有的文件，国家法律法规数据库提供的链接有错误
            png = re.sub(rf'//{type}', f'/{type}', png)
        doc = re.sub(r'\.png', '.docx', png)
        if 'images/qr' in doc:  # 有的文件未提供下载源
            file = browser.find_element(By.ID,"viewDoc")
            doc = file.get_attribute("src")
        with open(f'{path4}/{t}-下载索引.txt', 'a+', encoding='utf-8') as f1:
            print(f'链接：{doc}\n', file=f1)
        print(f'{title}已建立下载链接！')
    except selenium.common.exceptions.TimeoutException:
        print('链接超时，当前ip可能被限制，请更换ip或者稍等一段时间后再次尝试。')
        sys.exit()

for i in range(len(l_list)):
    if i + 1 < len(l_list):  # 在没有获取下载链接的下载断点处继续下载，将导致后续链接全部出错，须自下载断点处重新运行脚本。
        if re.match(r'\d+：', l_list[i]) and (not re.match(r'链接.+', l_list[i + 1])):
            title = l_list[i][:-1] + '.' + law_list[i][3:]
            u = law_list[2 * i + 1][3:]
            print(f'{title}未建立下载链接，正在校正……')
            no = int(l_list[i][:-1])
            try:
                browser.get(u)
                codeMa = WebDriverWait(browser, 20, 0.5).until(EC.presence_of_element_located((By.ID, 'codeMa')))
                png = codeMa.get_attribute('src')
                png = re.sub(r'PNG', 'WORD', png)
                if f'//{type}' in png:  # 有的文件，国家法律法规数据库提供的链接有错误
                    png = re.sub(rf'//{type}', f'/{type}', png)
                doc = re.sub(r'\.png', '.docx', png)
                if 'images/qr' in doc:  # 有的文件未提供下载源
                    file = browser.find_element(By.ID,"viewDoc")
                    doc = file.get_attribute("src")
                f3 = f3 + l_list[i] + law_list[i][3:] + '\n'
                f3 = f3 + '链接：' + doc + '\n' + '\n'
                with open(f'{path4}/{t}-下载索引.txt', 'w') as f4:
                    f4.write(f3)
                print(f'{no + 1}：《{title}》已校正！')
                print(f'请重新运行法规爬虫2-建立下载索引.py，将从出错处重新建立下载索引。')
                sys.exit()
            except selenium.common.exceptions.TimeoutException:
                print('链接超时，当前ip可能被限制，请更换ip或者稍等一段时间后再次尝试。')
                sys.exit()

    if f'{type}/html' in l_list[i] or 'detail2.html?' in l_list[i]:  # 有的文件提供了下载源，单纯获取下载链接出错
        title = l_list[i - 1][:-1] + '.' + law_list[i - 1][3:]
        print(f'发现错误：{title}')
        u = law_list[i][3:]
        try:
            browser.get(u)
            codeMa = WebDriverWait(browser, 20, 0.5).until(EC.presence_of_element_located((By.ID, 'codeMa')))
            png = codeMa.get_attribute('src')
            png = re.sub(r'PNG', 'WORD', png)
            doc = re.sub(r'\.png', '.docx', png)
            if 'images/qr' in doc:  # 有的文件仅有pdf，或者其他错误，直接下载文件
                WebDriverWait(browser, 20, 0.5).until(EC.presence_of_element_located((By.ID, 'downLoadFile')))
                d = WebDriverWait(browser, 20, 0.5).until(EC.element_to_be_clickable((By.ID, 'downLoadFile')))
                d.click()
                # time.sleep(2)
                while True:
                    database = os.listdir(path2)
                    for j in database:
                        regex = re.compile(r"[0-9a-zA-Z]+\.[a-zA-Z]+")
                        k = re.match(regex, j)
                        if ('download' not in j) and (j != '.DS_Store') and k:
                            reg = re.compile(r"\..+")
                            k = k.group()
                            end = re.findall(reg, k)
                            os.rename(f'{path2}/{j}', f'{path2}/{title}{end[0]}')
                            f3 = f3 + '链接：已下载' + '\n' + '\n'
                            break
                    else:
                        time.sleep(1)
                        continue
                    break
            else:
                f3 = f3 + '链接：' + doc + '\n' + '\n'
        except selenium.common.exceptions.TimeoutException:
            print('链接超时，当前ip可能被限制，请更换ip或者稍等一段时间后再次尝试。')
            sys.exit()

    elif type == 'flfg' and (
            '/sfjs/' in l_list[i] or '/xzfg/' in l_list[i] or '/dfxfg/' in l_list[i]):  # 有的文件，国家法律法规数据库提供的链接有错误
        title = l_list[i - 1] + law_list[i - 1][3:]
        print(f'发现错误：{title}')
        doc = re.sub(r"/sfjs/|/xzfg/|/dfxfg/", '/flfg/', l_list[i][3:])
        f3 = f3 + '链接：' + doc + '\n' + '\n'
    elif type == 'sfjs' and (
            '/flfg/' in l_list[i] or '/xzfg/' in l_list[i] or '/dfxfg/' in l_list[i]):  # 有的文件，国家法律法规数据库提供的链接有错误
        title = l_list[i - 1] + law_list[i - 1][3:]
        print(f'发现错误：{title}')
        doc = re.sub(r"/flfg/|/xzfg/|/dfxfg/", '/sfjs/', l_list[i][3:])
        f3 = f3 + '链接：' + doc + '\n' + '\n'
    elif type == 'xzfg' and (
            '/sfjs/' in l_list[i] or '/flfg/' in l_list[i] or '/dfxfg/' in l_list[i]):  # 有的文件，国家法律法规数据库提供的链接有错误
        title = l_list[i - 1] + law_list[i - 1][3:]
        print(f'发现错误：{title}')
        doc = re.sub(r"/sfjs/|/flfg/|/dfxfg/", '/xzfg/', l_list[i][3:])
        f3 = f3 + '链接：' + doc + '\n' + '\n'
    elif type == 'dfxfg' and (
            '/sfjs/' in l_list[i] or '/xzfg/' in l_list[i] or '/flfg/' in l_list[i]):  # 有的文件，国家法律法规数据库提供的链接有错误
        title = l_list[i - 1] + law_list[i - 1][3:]
        print(f'发现错误：{title}')
        doc = re.sub(r"/sfjs/|/xzfg/|/flfg/", '/dfxfg/', l_list[i][3:])
        f3 = f3 + '链接：' + doc + '\n' + '\n'

    elif '链接：' in l_list[i]:  # 正确的链接
        f3 = f3 + l_list[i] + '\n' + '\n'
    else:  # 序号及名称
        f3 = f3 + l_list[i] + law_list[i][3:] + '\n'
print('正在纠正错误中，请稍后……')
with open(f'{path4}/{t}-下载索引.txt', 'w') as f4:
    f4.write(f3)
print(f'本次下载索引建立完毕，感谢使用；如果未建立全部下载索引，可再次运行本程序；如果尚有错误未校正，建议您先运行法规爬虫2-校验错误，校正错误后，再重新运行本脚本。')
