<div align="center">

<img src="https://antibrow.com/AntiBrow-mark.svg" alt="AntiBrow" height="72">

# antibrow

[English](https://github.com/antibrow/antibrow/blob/main/python/README.md) | **Русский**

**Антидетект-браузер, которым может управлять ваш AI-агент.**

Подмена отпечатка на уровне ядра · неограниченное количество локальных профилей, бесплатно · тот же API Playwright, который вы уже пишете

[![PyPI](https://img.shields.io/pypi/v/antibrow?color=6366f1&label=pypi)](https://pypi.org/project/antibrow/)
[![Python](https://img.shields.io/pypi/pyversions/antibrow?color=3776ab)](https://pypi.org/project/antibrow/)
[![CI](https://github.com/antibrow/antibrow/actions/workflows/ci.yml/badge.svg)](https://github.com/antibrow/antibrow/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-6366f1)](#поддержка-платформ)
[![Agent ready](https://img.shields.io/badge/agent-MCP%20ready-a855f7)](#ии-агенты-и-mcp)
[![License](https://img.shields.io/badge/wrapper-MIT-444)](LICENSE)

</div>

```python
from antibrow import launch

browser = launch()
page = browser.new_page()
page.goto("https://abrahamjuliot.github.io/creepjs/")
```

Это настоящий Chromium - с отпечатком настоящего устройства, собственным устойчивым профилем и без шага `playwright install` - управляемый тем самым API Playwright, который вы уже знаете.

---

## Содержание

- [Почему antibrow](#почему-antibrow)
- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [Справочник API](#справочник-api)
- [Профили и отпечатки](#профили-и-отпечатки)
- [Прокси](#прокси)
- [Интеграции с фреймворками](#интеграции-с-фреймворками)
  - [Playwright](#playwright) · [Puppeteer / Node](#переход-с-puppeteer-или-node-sdk) · [browser-use](#browser-use) · [crawl4ai](#crawl4ai) · [Scrapling](#scrapling) · [MCP](#ии-агенты-и-mcp) · [Selenium](#selenium)
- [Автоматизация в больших масштабах](#автоматизация-в-больших-масштабах)
- [Docker](#docker)
- [CLI](#cli)
- [Поддержка платформ](#поддержка-платформ)
- [Тарифы и параллелизм](#тарифы-и-параллелизм)
- [FAQ](#faq)
- [Лицензия](#лицензия)

## Почему antibrow

**Подмена происходит в движке, а не в скрипте.** Большинство инструментов для скрытности патчат JavaScript снаружи: переопределяют геттер, подменяют `navigator`, монки-патчат `toString`. Поставщики антибот-решений годами учатся распознавать такие патчи. antibrow поставляет модифицированный Chromium - Canvas, WebGL, WebGPU, аудио, шрифты, `navigator`, экран, DOMRect и часовой пояс обрабатываются внутри C++/Blink, поэтому искать инжектированный скрипт нечего, ни один дескриптор свойства не оказывается не на своём месте, а контексты воркеров возвращают ровно то же, что и основной поток.

**Одна согласованная личность, зафиксированная на профиль.** Рандомизация каждого значения по отдельности сама по себе является сигналом: реальные устройства не сочетают AMD-рендерер со строкой vendor от Intel или device pixel ratio 1.0 с экраном 1536×864. Каждый профиль получает одну самосогласованную персону в момент создания и хранит её вечно - тот же UA, тот же GPU, те же сиды, те же шрифты, от запуска к запуску.

**Часовой пояс следует за прокси.** Передайте прокси - и исходящий IP будет определён через этот же прокси; часовой пояс браузера и личность WebRTC устанавливаются по нему ещё до первого байта первой страницы.

**Аутентифицированные прокси - и ничего не нужно устанавливать, чтобы они заработали.** `socks5://user:pass@host:port` работает как есть: запросы `407` для HTTP/HTTPS обрабатываются прямо в сетевом стеке, SOCKS5 - по протоколу согласования логина/пароля из RFC 1929, и всё это внутри движка. `chrome://extensions` остаётся пустым - вспомогательное расширение для авторизации прокси, которое до сих пор поставляют многие антидетект-браузеры, можно перечислить с любой страницы, и само по себе является демаскирующим признаком.

**Неограниченные локальные профили, бесплатно.** Профиль - это каталог. Назовите один - и он существует. Никакой платы за профиль и ничего, что нужно было бы готовить заранее. Ваш тариф определяет, сколько браузеров работает *одновременно*, а не сколько личностей вы можете иметь.

**Создан для агентов.** `launch()` отдаёт живую конечную точку CDP вместе с объектом Playwright, поэтому browser-use, crawl4ai, Scrapling, ваш собственный MCP-сервер или обычный Playwright подключаются без клеевого кода.

## Установка

```bash
pip install antibrow
```

Затем скачайте ядро браузера и сохраните свой API-ключ (оба шага одноразовые):

```bash
python -m antibrow install     # downloads + extracts the kernel (~190 MB zip, ~440 MB on disk)
python -m antibrow login       # stores your key in ~/.antibrow/license.key
```

> **API-ключ обязателен.** Ядро проверяет короткоживущий токен лицензии, подписанный сервером, при запуске и отказывается работать без него - эта проверка вкомпилирована в бинарник, поэтому офлайн-режима не существует. **Бесплатный ключ** (1 одновременный браузер, неограниченные локальные профили) доступен на **[antibrow.com](https://antibrow.com/ru)**. Этот пакет никогда не подписывает токены сам: он обменивает ваш ключ на токен по HTTPS и кеширует его, поэтому даже при частых перезапусках сеть используется примерно раз в день.

`playwright install` вам **не** понадобится - antibrow управляет собственным ядром, а не встроенными браузерами Playwright. Пакет `playwright` всё равно требуется (ради клиентской библиотеки).

Пропустить `install` тоже можно: первый же `launch()` скачает нужное ядро сам.

## Быстрый старт

```python
from antibrow import launch

# A named profile: same fingerprint, cookies and storage every time.
browser = launch(profile="shopper-01")

page = browser.new_page()
page.goto("https://whoer.net")
print(page.title())

browser.close()
```

Контекстный менеджер, headless, прокси, часовой пояс по гео:

```python
from antibrow import launch

with launch(
    profile="scraper-eu",
    headless=True,
    proxy="http://user:pass@gate.example.com:8080",
    geoip=True,                       # timezone + WebRTC follow the proxy exit
) as browser:
    page = browser.new_page()
    page.goto("https://example.com")
    print(browser.timezone, browser.public_ip)
```

Асинхронно, для агентов и параллельных обходов:

```python
import asyncio
from antibrow import launch_async

async def main():
    browser = await launch_async(profile="agent-01")
    page = await browser.new_page()
    await page.goto("https://example.com")
    print(await page.title())
    await browser.close()

asyncio.run(main())
```

Больше примеров в [`examples/`](examples/).

## Справочник API

### `launch(profile="default", **options) -> Antibrow`

Запускает ядро и возвращает готовый к работе объект. Блокирующий (синхронный) API.

| Опция | Тип | По умолчанию | Что делает |
|---|---|---|---|
| `profile` | `str` | `"default"` | Имя профиля. Одинаковое имя - одинаковая личность, куки, хранилище. Неограниченно, бесплатно, локально. |
| `focus_window` | `bool` | `True` | Получает ли новое окно фокус. `False` открывает его позади того, что сейчас на переднем плане, так что запуск вас не прерывает - окно всё равно есть, просто не в фокусе. Это не headless-режим. Нужна сборка ядра, несущая этот переключатель (macOS `2026-08-10`+); более старые сборки в любом случае выводят окно на передний план. |
| `headless` | `bool` | `False` | Скрыть окно. В Windows окно перемещается за пределы экрана вместо `--headless=new`, потому что headless-Chromium имеет собственный обнаруживаемый отпечаток. В Linux используйте Xvfb (см. [Docker](#docker)); в macOS пока не действует. |
| `proxy` | `str \| dict` | `None` | `"http://user:pass@host:port"`, `"socks5://…"`, `"https://…"` или словарь Playwright `{"server": …, "username": …, "password": …}`. |
| `geoip` | `bool` | `True` | Определить исходящий IP прокси через сам прокси и подогнать под него часовой пояс и WebRTC. Не действует без прокси. |
| `timezone` | `str` | `None` | Принудительно задать часовой пояс IANA (`"Europe/Berlin"`), переопределяя определение по гео. |
| `api_key` | `str` | env / файл ключа | API-ключ AntiBrow. |
| `server` | `str` | `https://antibrow.com` | Базовый URL сервера лицензий. |
| `cache_dir` | `path` | `~/.anti-detect-browser` | Где хранятся ядра и профили. |
| `profile_dir` | `path` | `None` | Точный каталог профиля, в обход `cache_dir`/`profile`. |
| `kernel_version` | `str` | самая новая | Ядро для **нового** профиля. Существующие профили сохраняют версию, зафиксированную в их персоне. |
| `label` | `str` | имя профиля | Текст, показываемый ядром в метке адресной строки - позволяет отличать окна с первого взгляда. |
| `args` | `list[str]` | `None` | Дополнительные переключатели Chromium. |
| `proxy_auth` | `"native" \| "extension"` | `"native"` | Как обрабатываются учётные данные прокси. Native - внутри сетевого стека, без расширения. |
| `license_token` | `str` | `None` | Использовать заранее выпущенный токен вместо обращения к серверу. |
| `license_provider` | `callable` | `None` | Вернуть токен от своего собственного эмитента (self-hosted, vault, CI). |
| `update_kernel` | `bool` | `False` | Проверить наличие более новой сборки ядра этого профиля и установить её перед запуском. |
| `device_type` | `"desktop" \| "android"` | `"desktop"` | Симулировать Android-телефон вместо настольного браузера. Применяется только при **создании** профиля; см. [Android-профили](#android-профили). |
| `real_fingerprint` | `bool` | `False` | Брать личность из библиотеки отпечатков на сервере, а не генерировать её (платные тарифы). Тоже только в момент создания. |
| `sync` | `bool` | зависит от тарифа | Облачная синхронизация профиля: восстановление перед запуском, сохранение после закрытия. `None` следует тарифу, на котором находится ключ, `False` оставляет запуск локальным, `True` пытается синхронизировать в любом случае. |
| `on_sync` | `callable` | `None` | Получает `SyncEvent` при начале и завершении каждой передачи. |
| `webauthn_capture` | `bool` | `True` | Хранить новые passkeys в переносимом хранилище профиля, чтобы они переносились вместе с синхронизацией или экспортом. `False` позволяет браузеру спросить, куда сохранить (телефон / ключ безопасности), и они останутся на этом устройстве. |
| `reuse_initial_page` | `bool` | `True` | Позволить первому вызову `new_page()` вернуть исходную пустую вкладку Chromium вместо открытия второй. |
| `timeout` | `float` | `120.0` | Сколько секунд ждать запуска браузера. |
| `on_progress` | `callable` | `None` | Получает строки прогресса (`"Downloading 42%"`, `"CDP endpoint ready …"`). |

### Объект `Antibrow`

Обращения к атрибутам, которых нет напрямую, проваливаются в Playwright `BrowserContext`, поэтому всё, что вы вызвали бы на контексте, работает прямо на этом объекте.

```python
browser = launch(profile="p1")

page  = browser.new_page()          # -> Playwright Page
pages = browser.pages               # -> delegated to the context
browser.add_init_script("…")        # -> delegated
browser.add_cookies([...])          # -> delegated

browser.context                     # the raw Playwright BrowserContext
browser.browser                     # the raw Playwright Browser (CDP connection)
browser.page                        # first page, created on demand

browser.cdp_endpoint                # 'ws://127.0.0.1:54321/devtools/browser/…'
browser.cdp_url                     # 'http://127.0.0.1:54321'  (what crawl4ai wants)
browser.profile_dir                 # Path to this profile on disk
browser.persona                     # the frozen identity (UA, GPU, screen, seeds…)
browser.timezone, browser.public_ip # resolved from the proxy when geoip=True
browser.kernel_version, browser.pid
browser.synced                      # True when this profile has a cloud archive slot
browser.sync_error                  # why the closing upload failed, if it did
browser.plan                        # everything resolved for this launch
browser.plan.redacted_args()        # the command line, secrets masked - paste into bug reports

browser.close()                     # closes the browser and reaps the process tree
```

`close()` также упаковывает профиль и загружает его, если включена синхронизация, - именно в этот момент куки, хранилище и passkeys достигают облака. Он никогда не выбрасывает исключение из-за сбоя синхронизации - если нужно узнать причину, проверьте `browser.sync_error` (или `on_sync`).

`new_page()` при первом вызове отдаёт исходную пустую вкладку Chromium (Chromium всегда открывается с одной), а затем открывает настоящие новые вкладки. Используйте `browser.context.new_page()`, если вам всегда нужна свежая вкладка.

### Другие точки входа

```python
from antibrow import launch_async, launch_persistent_context, prepare_launch

browser = await launch_async(profile="p1")          # asyncio twin of launch()
context = launch_persistent_context(profile="p1")   # raw Playwright BrowserContext
plan    = prepare_launch(profile="p1")              # resolve everything, start nothing
```

`prepare_launch()` возвращает точный исполняемый файл, аргументы, персону и часовой пояс, которые использовал бы запуск, не запуская сам процесс - полезно для тестов, сухих прогонов и отчётов об ошибках.

### Ошибки

Любая намеренная ошибка наследуется от `AntibrowError`:

```python
from antibrow import AntibrowError, ConcurrencyLimitError, LicenseError

try:
    browser = launch()
except ConcurrencyLimitError:
    ...   # the plan's simultaneous-browser cap is in use (enforced by the kernel)
except LicenseError:
    ...   # no API key, or the server rejected it
except AntibrowError:
    ...   # kernel download, unsupported platform, proxy, launch failure
```

## Профили и отпечатки

Профиль - это каталог внутри `~/.anti-detect-browser/profiles/<name>/`:

```
persona.json     the frozen identity - written once, never regenerated
fp-config.json   the persona serialized for the kernel, rewritten each launch
user-data/       Chromium's profile: cookies, storage, history, extensions
```

Каталог кеша общий с [Node SDK](https://www.npmjs.com/package/anti-detect-browser) и десктопным приложением AntiBrow, поэтому профиль, созданный из Python, появляется в списке десктопного приложения, и наоборот. Переопределяется через `ANTIBROW_CACHE_DIR` или `cache_dir=`.

Что фиксирует персона:

| Поверхность | Пример |
|---|---|
| User agent + `navigator` | Windows 11 / текущий Chrome, `platform`, `vendor`, `hardwareConcurrency`, `deviceMemory`, `maxTouchPoints`, UA-CH `platformVersion` |
| Экран | CSS-размер, `availWidth/Height` за вычетом панели задач, `colorDepth`, `devicePixelRatio` (никогда не 1.0) |
| GPU | соответствующие unmasked vendor и renderer WebGL (Intel / NVIDIA / AMD) |
| Canvas, аудио, DOMRect | сиды на профиль → детерминированный шум, идентичный при каждом визите |
| Шрифты | набор шрифтов Windows, Segoe UI, без утечки CJK |
| Локаль | `languages`, `Accept-Language` и часовой пояс (по прокси, когда `geoip=True`) |
| WebRTC | сквозная передача с публичным IP прокси, либо отключено при отсутствии прокси |

Детерминированность важна не меньше самих значений: браузер, возвращающий *новый* хеш canvas при каждом вызове, вычисляется элементарно. Сиды стабильны для каждого профиля, поэтому повторные визиты согласуются друг с другом.

Проверить живую личность:

```python
browser = launch(profile="p1")
print(browser.persona.ua, browser.persona.gpu_renderer, browser.persona.screen_w)
```

Проверки, которые стоит один раз прогнать: [creepjs](https://abrahamjuliot.github.io/creepjs/), [whoer.net](https://whoer.net), [browserleaks.com/canvas](https://browserleaks.com/canvas), [pixelscan.net](https://pixelscan.net).

### Android-профили

Профиль может быть телефоном вместо настольного браузера - работающим на той же машине с Windows, macOS или Linux, без парка устройств и удалённого железа:

```python
browser = launch(profile="phone-01", device_type="android")
```

Всё, что может прочитать страница, отвечается прямо в ядре, с одного настоящего устройства:

| Поверхность | Что сообщает Android-профиль |
|---|---|
| UA + client hints | UA `Mobile Safari`, `Sec-CH-UA-Mobile: ?1`, `Sec-CH-UA-Platform: "Android"`, настоящие `model` и `platformVersion`, `formFactors: ["Mobile"]`, пустые `architecture` / `bitness` |
| `navigator` | `platform` `"Linux armv81"`, `maxTouchPoints`, мобильные значения ядер/памяти, отсутствие плагинов и mime-типов, `pdfViewerEnabled` false |
| Сенсор и раскладка | `ontouchstart`, `window.orientation`, портретная `screen.orientation`, `(pointer: coarse)` / `(hover: none)`, окно подогнано под размер экрана устройства, так что `innerWidth == screen.width` на странице с viewport-meta |
| GPU | мобильные unmasked vendor/renderer и расширения сжатых текстур ETC/ASTC, которые действительно выставляет GPU телефона |
| Экран, аудио, шрифты, соединение | взяты с того же устройства |

Три настоящих телефона поставляются прямо внутри пакета, поэтому профиль на бесплатном тарифе может быть Android без предварительной загрузки чего-либо. Целая строка устройства выбирается за раз, никогда поле за полем - именно это удерживает экран, отчёт GPU и client hints согласованными друг с другом.

```python
browser = launch(profile="phone-01", device_type="android")
print(browser.persona.android_model, browser.persona.android_os_major)
```

Два ограничения:

- **Тип устройства фиксируется при создании**, внутри `persona.json`. Передача `device_type` для уже существующего профиля ничего не даёт; чтобы переключиться, создайте новый профиль.
- **Для Android нужно ядро `151.0.7922.72`**, сборка `2026-08-07` или новее. Эта версия закрепляется автоматически для Android-профилей и устанавливается (или обновляется) за вас; если в установке всё ещё нет поддержки мобильных устройств, запуск завершится исключением, а не запустит настольное ядро под маской телефона. `antibrow.kernel_supports_android(version, build)` отвечает на тот же вопрос напрямую.

Чтобы каждый раз получать другую реальную машину вместо трёх встроенных строк, добавьте `real_fingerprint=True` (платные тарифы; работает и для `device_type="desktop"`, подбирая машину с Windows). Бесплатный ключ сервер отклоняет, а не тихо понижает до сгенерированной персоны.

## Прокси

```python
launch(proxy="http://user:pass@gate.example.com:8080")
launch(proxy="https://user:pass@gate.example.com:443")
launch(proxy="socks5://user:pass@127.0.0.1:1080")
launch(proxy={"server": "http://gate.example.com:8080", "username": "u", "password": "p"})
```

Учётные данные обрабатываются **внутри ядра** - запросы 407 для HTTP/HTTPS обрабатываются прямо в сетевом стеке, SOCKS5 использует согласование логина/пароля из RFC 1929. В `chrome://extensions` ничего не загружается - а именно такого демаскирующего признака антидетект-браузер и не должен иметь. (`proxy_auth="extension"` воспроизводит более старый подход на MV3, если он вам всё же понадобится для HTTP-прокси; для SOCKS5 он не годится.)

Пароли, содержащие `@`, `:` или `/`, допустимы - процент-кодируйте их в URL либо используйте форму словаря.

При `geoip=True` (по умолчанию) исходящий IP определяется *через* прокси перед запуском, а его часовой пояс записывается в отпечаток:

```python
browser = launch(profile="p1", proxy="socks5://user:pass@127.0.0.1:1080")
print(browser.public_ip, browser.timezone)   # 203.0.113.7 America/Los_Angeles
```

## Интеграции с фреймворками

Каждая интеграция работает одинаково: antibrow запускает браузер, а вы передаёте его **конечную точку CDP** тому, что должно им управлять.

```python
browser = launch(profile="p1")
browser.cdp_url        # http://127.0.0.1:54321
browser.cdp_endpoint   # ws://127.0.0.1:54321/devtools/browser/…
```

### Playwright

Этот объект *и есть* Playwright. У существующих скриптов меняется только строка запуска:

```python
# before
# from playwright.sync_api import sync_playwright
# pw = sync_playwright().start()
# browser = pw.chromium.launch()
# context = browser.new_context()

from antibrow import launch
context = launch(profile="p1")        # a BrowserContext in all but name

page = context.new_page()
page.goto("https://example.com")
page.get_by_role("button", name="Sign in").click()
```

Нужен буквально сам объект для API, который проверяет его тип:

```python
from antibrow import launch_persistent_context
context = launch_persistent_context(profile="p1")   # playwright BrowserContext
context.close()                                     # also stops the kernel
```

Полный пример: [`examples/04_playwright.py`](examples/04_playwright.py).

### Переход с Puppeteer или Node SDK

Один и тот же продукт, два рантайма - [`anti-detect-browser`](https://www.npmjs.com/package/anti-detect-browser) на npm, `antibrow` на PyPI, с общим каталогом кеша, общим форматом профиля и общим аккаунтом.

```js
// Node
const ab = new AntiDetectBrowser({ key: process.env.ANTI_DETECT_BROWSER_KEY })
const { page, browser } = await ab.launch({ profile: 'shopper-01' })
await page.goto('https://example.com')
await browser.close()
```

```python
# Python
browser = launch(profile="shopper-01")
page = browser.new_page()
page.goto("https://example.com")
browser.close()
```

Пользователям Puppeteer: конечная точка - это обычный CDP, поэтому `puppeteer.connect({ browserURL: browser.cdp_url })` работает из любого языка. Соответствие рядом друг с другом - в [`examples/05_puppeteer_style.py`](examples/05_puppeteer_style.py).

### browser-use

```python
from antibrow import launch_async
from browser_use import Agent, Browser, ChatOpenAI

session = await launch_async(profile="agent-01", proxy="http://user:pass@gate:8080")
agent = Agent(
    task="Find the cheapest flight from Berlin to Lisbon next month",
    llm=ChatOpenAI(model="gpt-4.1-mini"),
    browser=Browser(cdp_url=session.cdp_url),
)
await agent.run()
```

[`examples/06_browser_use.py`](examples/06_browser_use.py) - включает запасное написание для более старых релизов browser-use (`BrowserSession(cdp_url=…)`).

### crawl4ai

```python
from antibrow import launch_async
from crawl4ai import AsyncWebCrawler, BrowserConfig

session = await launch_async(profile="crawler-01")
config = BrowserConfig(cdp_url=session.cdp_url, headless=False)

async with AsyncWebCrawler(config=config) as crawler:
    result = await crawler.arun(url="https://example.com")
    print(result.markdown)
```

[`examples/07_crawl4ai.py`](examples/07_crawl4ai.py)

### Scrapling

```python
from antibrow import launch
from scrapling.fetchers import DynamicFetcher

browser = launch(profile="scrapling-01")
page = DynamicFetcher.fetch("https://example.com", cdp_url=browser.cdp_endpoint)
print(page.css_first("h1::text"))
```

[`examples/08_scrapling.py`](examples/08_scrapling.py)

### ИИ-агенты и MCP

Любой MCP-клиент может управлять браузером со снабжённым отпечатком. [`examples/09_mcp_server.py`](examples/09_mcp_server.py) - это полноценный stdio-сервер MCP (`pip install "antibrow[mcp]"`), предоставляющий `launch_browser`, `navigate`, `click`, `fill`, `get_content`, `screenshot`, `evaluate` и `close_browser`:

```json
{
  "mcpServers": {
    "antibrow": {
      "command": "python",
      "args": ["/abs/path/to/examples/09_mcp_server.py"],
      "env": { "ANTIBROW_API_KEY": "your-api-key" }
    }
  }
}
```

Пакет для Node поставляет MCP-сервер из коробки (`npx anti-detect-browser --mcp`), если вы не хотите запускать пример.

### Selenium

Selenium не может подключиться к конечной точке, работающей только через CDP, без подходящего chromedriver, поэтому поддерживаемой привязки к Selenium сегодня нет. Если вы переезжаете с него, раздел про Playwright выше - самый короткий путь; откройте issue, если поддержка chromedriver для вас важна.

## Автоматизация в больших масштабах

Автоматизация обычно создаёт отдельный профиль под каждую задачу. Передайте `temporary=True`,
чтобы такие профили оказывались в отдельном дереве каталогов, не мешая
профилям, которыми вы управляете вручную:

```python
from antibrow import launch, clear_temporary_profiles

for task in tasks:
    browser = launch(f"task-{task.id}", temporary=True)
    page = browser.new_page()
    page.goto(task.url)
    browser.close()

# Temporary profiles are never deleted for you.
removed = clear_temporary_profiles(older_than_days=7)
print(f"removed {len(removed)} temporary profiles")
```

Три вещи, которые стоит знать:

- **Они не отображаются в десктопном приложении.** Десктопное приложение
  читает только управляемое дерево, поэтому временный профиль для него невидим.
- **Два дерева - это разные пространства имён.** Временный `gmail` и
  управляемый `gmail` - это два разных профиля со своей личностью и куками.
- **Ничего не удаляется автоматически.** Временный профиль хранит свою
  личность и свои сессии столько, сколько вы оставляете его на диске, - это и
  делает его пригодным для повторного использования. Удаляйте их сами через
  `clear_temporary_profiles()` или
  `python -m antibrow clear-temp --older-than=7`.

При каждом запуске `temporary=False` возвращает один профиль обратно в управляемое дерево.

### Облачная синхронизация

Запуск сам по себе никогда не создаёт облачный профиль. По умолчанию профиль
синхронизируется только тогда, когда сервер уже знает это имя, поэтому запуск
автоматизации не может заполнить вашу квоту синхронизации профилями, которые
вы вовсе не собирались оставлять. Чтобы поместить новый профиль в облако,
запросите это явно:

```python
launch("main-account", sync=True)    # create + sync
launch("main-account", sync=False)   # stay local
```

`sync=True` и `temporary=True` взаимно исключают друг друга; передача обоих
вызовет исключение. `sync=True` также вызовет исключение, если ваш тариф не
включает облачную синхронизацию.

## Docker

Ядро для Linux работает в headful-режиме под Xvfb - настоящий headless-Chromium имеет собственный отпечаток, поэтому образ рендерит на виртуальный дисплей вместо этого. Приведённый ниже образ работает и на `linux/amd64`, и на `linux/arm64`; подходящая сборка ядра выбирается по процессору контейнера, так что ничего архитектурно-специфичного здесь нет.

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libpango-1.0-0 libcairo2 fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir antibrow
COPY script.py .
CMD ["xvfb-run", "-a", "python", "script.py"]
```

```bash
docker build -t my-scraper .
docker run --rm -e ANTIBROW_API_KEY=$ANTIBROW_API_KEY \
  -v antibrow-cache:/root/.anti-detect-browser my-scraper
```

Монтирование тома с кешем сохраняет ядро (и ваши профили) между запусками. Полный образ - в [`Dockerfile`](Dockerfile) этого репозитория; см. [`examples/10_docker/`](examples/10_docker/).

## CLI

```bash
python -m antibrow install [--version 150.0.7871.182] [--force]   # get the kernel
python -m antibrow info                                           # kernels, profiles, license
python -m antibrow login [--key ab_live_…]                        # store an API key
python -m antibrow clear-temp [--older-than 7] [--dry-run]        # delete temporary profiles
python -m antibrow version                                        # SDK + default kernel
```

`antibrow …` тоже работает (консольный скрипт). `info` - первое, что стоит запустить, когда что-то не так: команда выводит каталог кеша, каждую версию ядра со статусом установки/обновления, все профили с закреплённым за ними ядром и место, где был найден ваш API-ключ.

### Переменные окружения

| Переменная | Назначение |
|---|---|
| `ANTIBROW_API_KEY` | API-ключ (также принимает `ANTI_DETECT_BROWSER_KEY` из Node SDK) |
| `ANTIBROW_LICENSE_TOKEN` | Заранее выпущенный токен лицензии; полностью пропускает обращение к серверу |
| `ANTIBROW_CACHE_DIR` | Корень для ядра и профилей (по умолчанию `~/.anti-detect-browser`) |
| `ANTIBROW_SERVER` | Базовый URL сервера лицензий |

## Поддержка платформ

| Платформа | Статус | Заметки |
|---|---|---|
| Windows 10/11 x64 | Поддерживается | Headful, либо headless через окно за пределами экрана |
| macOS 12+ (Apple silicon + Intel) | Поддерживается | Универсальная сборка. Headful - `headless=True` здесь пока не действует |
| Linux x64 (glibc) | Поддерживается | Для headless нужен Xvfb; флаги контейнера применяются автоматически |
| Linux arm64 (glibc) | Поддерживается | Отдельная сборка arm64, выбирается автоматически по процессору |
| Docker (linux/amd64, linux/arm64) | Поддерживается | См. [Docker](#docker) |
| Linux musl (Alpine) | Пока не поддерживается | Нет сборки ядра |

Python 3.9 - 3.13. Ядро кешируется один раз на версию - около 190 МБ для скачивания на
Windows и Linux, около 320 МБ для универсальной сборки macOS (она несёт обе
архитектуры) - а `python -m antibrow info` показывает, что установлено и где.

## Тарифы и параллелизм

Локальные профили не ограничены на любом тарифе, включая бесплатный. С тарифом масштабируется то, сколько браузеров работает **одновременно** - это обеспечивает само ядро (межпроцессные файловые блокировки), а не этот SDK, поэтому обойти ограничение запуском большего числа процессов Python нельзя.

| Тариф | Локальные профили | Одновременные браузеры | Облачная синхронизация | Управляемые прокси |
|---|:--:|:--:|:--:|:--:|
| Free | без ограничений | 1 | - | - |
| Basic | без ограничений | 5 | да | да |
| Pro | без ограничений | 20 | да | да |
| Team | без ограничений | 100 | да | да |

Подробности на [antibrow.com/pricing](https://antibrow.com/ru/tseny). Превышение лимита вызывает `ConcurrencyLimitError` вместо зависания.

### Синхронизация профиля в облаке

На платном тарифе запуск восстанавливает профиль перед стартом и сохраняет его снова при
`close()`, поэтому на следующей машине открываются те же куки, хранилище, история и
passkeys. Там это включено по умолчанию и не требует дополнительного кода:

```python
from antibrow import launch

browser = launch(profile="shopper-01")   # restored from the cloud
...
browser.close()                          # saved back
if browser.sync_error:
    print("not saved:", browser.sync_error)
```

Следите за передачами через `on_sync=`, либо держите запуск локальным через `sync=False`.
Проблемы синхронизации никогда не приводят к сбою запуска: локальный каталог профиля всегда пригоден для использования.

Профили также можно переносить файлом. `export_profile_archive()` записывает `.fpprofile`
(личность, состояние браузера, хранилище passkeys), который читает обратно
`import_profile_archive()` - в этом SDK или в десктопном приложении:

```python
from antibrow import PortableProfileMeta, export_profile_archive, import_profile_archive, profile_dir

data = export_profile_archive(profile_dir("shopper-01"), PortableProfileMeta(name="shopper-01"))
open("shopper-01.fpprofile", "wb").write(data)          # export with the browser closed

meta = import_profile_archive(data, profile_dir("shopper-02"))
```

Live View по-прежнему доступен только в Node SDK и десктопном приложении.

## FAQ

**Нужен ли мне `playwright install`?**
Нет. antibrow скачивает и запускает собственное ядро. Пакет `playwright` для pip требуется ради его клиентской библиотеки, но встроенные в него браузеры никогда не используются.

**Работает ли это без API-ключа?**
Нет. Проверка лицензии вкомпилирована в бинарник ядра. Бесплатный ключ доступен на [antibrow.com](https://antibrow.com/ru), и одного токена хватает на целый день перезапусков.

**Куда уходят мои данные?**
Профили никогда не покидают вашу машину в рамках этого пакета. Единственные исходящие обращения: скачивание ядра (`download.antibrow.com`), обмен токена (`antibrow.com`) и - только при `geoip=True` *и* заданном прокси - один запрос к `ip-api.com` **через ваш прокси**, чтобы узнать его часовой пояс на выходе.

**Могу ли я использовать собственный каталог профиля / примонтировать его в CI?**
Да: `launch(profile_dir="/data/profiles/acct-17")` либо установите `ANTIBROW_CACHE_DIR`. Скопируйте каталог, чтобы перенести личность между машинами.

**Обнаруживаем ли headless-режим?**
Настоящий headless-Chromium - да, поэтому `headless=True` в Windows вместо этого перемещает окно за пределы экрана. В Linux запускайте headful под Xvfb (как это делает Dockerfile).

**Как поддерживать ядро в актуальном состоянии?**
`python -m antibrow install --force` либо `launch(update_kernel=True)`. Установленные ядра никогда не подменяются без вашего ведома.

**Что-то падает при запуске - что присылать?**
`python -m antibrow info` и `prepare_launch(...).redacted_args()`. Оба безопасно вставлять куда угодно - токен лицензии и пароль прокси замаскированы.

**Законно ли это использовать?**
Это браузер. Сбор публичных данных, тестирование собственного антифрод-стека и управление собственными аккаунтами - обычные сценарии использования. Мошенничество, credential stuffing и нарушение условий использования сайта - нет, и здесь не поддерживаются.

## Лицензия

Две лицензии, и граница между ними важна:

- **Этот репозиторий - обёртка на Python, CLI, примеры и документация - под лицензией [MIT](LICENSE).** Форкайте, вендорите, поставляйте.
- **Бинарник ядра браузера - закрытый исходный код с отдельной лицензией.** Его нет ни в этом репозитории, ни в пакете PyPI; он скачивается с собственного CDN AntiBrow во время выполнения, конечным пользователем, на машину конечного пользователя. Распространение, перепродажа или переупаковка этого бинарника не допускаются. Полные условия и граница OEM/SaaS: [BINARY-LICENSE.md](BINARY-LICENSE.md).

Зависимость от этого пакета **не** делает вас распространителем ядра.

## Ссылки

- Сайт и API-ключи - [antibrow.com](https://antibrow.com/ru)
- Документация - [antibrow.com/docs/sdk](https://antibrow.com/ru/dokumentatsiya/sdk)
- Node/TypeScript SDK - [`anti-detect-browser`](https://www.npmjs.com/package/anti-detect-browser)
- Десктопное приложение - [antibrow.com/download](https://antibrow.com/ru/skachat)
- Issues - [GitHub](https://github.com/antibrow/antibrow/issues)
