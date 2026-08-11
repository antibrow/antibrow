<p align="center">
  <strong>AntiBrow</strong><br>
  <em>Антидетект-браузер, которым может управлять ваш AI-агент.</em>
</p>

[English](README.md) | **Русский**

<p align="center">
  <a href="https://pypi.org/project/antibrow/"><img src="https://img.shields.io/pypi/v/antibrow" alt="PyPI"></a>
  <a href="https://www.npmjs.com/package/anti-detect-browser"><img src="https://img.shields.io/npm/v/anti-detect-browser" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/SDK%20license-MIT-blue" alt="MIT"></a>
  <a href="https://antibrow.com/ru"><img src="https://img.shields.io/badge/site-antibrow.com-111" alt="Website"></a>
</p>

---

Подмена отпечатка на уровне ядра, управляемая через **стандартный API Playwright, который вы
уже используете**. Каждый профиль несёт согласованный отпечаток настоящего устройства -
canvas, WebGL, WebGPU, аудио, шрифты, WebRTC и уровень протокола согласованы между собой,
потому что все они сняты с одной реальной машины, а не рандомизированы по отдельности.

В этом репозитории находятся **SDK с открытым исходным кодом**. Что открыто, а что нет -
см. в разделе [Лицензирование](#лицензирование).

```
python/   →  PyPI: antibrow
js/       →  npm:  anti-detect-browser
```

## Установка

**Python**

```bash
pip install antibrow
```

```python
from antibrow import launch

browser = launch()                      # engine downloads on first run
page = browser.new_page()
page.goto("https://example.com")
browser.close()
```

**JavaScript / TypeScript**

```bash
npm install anti-detect-browser playwright-core
```

```js
import { openProfile } from 'anti-detect-browser'

const session = await openProfile({ key: process.env.ANTIBROW_KEY, profileName: 'default' })
const page = await session.context.newPage()
await page.goto('https://example.com')
await session.close()
```

Оба SDK используют один и тот же формат на диске: профиль, созданный одним из них, можно
запустить другим - с идентичным отпечатком.

## Что вы получаете

- **Подмена на уровне движка, а не JS-инъекции.** Отпечатки формируются внутри C++-слоя
  Chromium, поэтому детектору нечего искать - ни в `toString`, ни в прототипах, ни в стеке
  вызовов.
- **Согласованные профили реальных устройств.** 30+ категорий, 500+ параметров - всё взято с
  одной и той же реальной машины. Рандомизированные значения противоречат друг другу, эти -
  нет.
- **Android-профили на настольной машине.** `device_type="android"` (`deviceType: 'android'`
  в JS) даёт профилю личность настоящего телефона - мобильные client hints, сенсорный ввод,
  портретный экран, мобильный GPU - без парка устройств и удалённого железа. Настоящие
  телефоны поставляются внутри обоих пакетов, поэтому это работает и на бесплатном тарифе.
- **Часовой пояс и локаль следуют за прокси.** Передайте прокси - и гео исходящего IP будет
  определено и записано в отпечаток ещё до запуска.
- **Аутентификация прокси обрабатывается в движке.** Учётные данные `http` / `https` /
  `socks5` передаются прямо в `--proxy-server`; ядро само отвечает на запрос авторизации.
  Никакое вспомогательное расширение не загружается, поэтому в `chrome://extensions` ничего
  не появляется.
- **Устойчивые личности.** Куки, хранилище и passkeys переживают перезапуски - один раз
  прогретый аккаунт остаётся прогретым.
- **Стандартный Playwright.** Вы получаете обычный `BrowserContext` через CDP. Никакого
  проприетарного API учить не нужно, а существующие скрипты переносятся заменой одной
  строки запуска.
- **Режим MCP-сервера**, чтобы AI-агент мог управлять профилем напрямую.

## Документация и примеры

| | |
|---|---|
| API Python, опции, CLI | [`python/README.ru.md`](python/README.ru.md) |
| API JavaScript | [`js/README.ru.md`](js/README.ru.md) |
| Готовые к запуску примеры (Playwright, browser-use, crawl4ai, Scrapling, MCP, Docker) | [`python/examples/`](python/examples/) |

## Платформы

Windows x64, macOS (universal) и Linux x64 / arm64.

## Лицензирование

Прочтите это, прежде чем строить что-то поверх SDK - у SDK и движка **разные лицензии**.

- **SDK в этом репозитории распространяются под MIT** ([`LICENSE`](LICENSE)). Используйте их
  где угодно, в том числе в коммерческих проектах.
- **Движок браузера - это закрытый бинарник**, распространяемый отдельно, по условиям
  [`BINARY-LICENSE.md`](BINARY-LICENSE.md). Кратко: вы можете использовать его для
  собственной работы, в том числе коммерческой, при любом размере компании - но не можете
  распространять, перепродавать, переупаковывать или встраивать его, а предоставление
  доступа к нему сторонним клиентам (в составе продукта, как хостинг-услугу или за своим
  собственным API) требует отдельной лицензии OEM/SaaS.
- **Указание этих пакетов как зависимости не является распространением**, поскольку движок
  скачивается с официальных каналов AntiBrow непосредственно на машину пользователя.

`BINARY-LICENSE.md` - это исходный текст, имеющий силу; приведённое выше резюме его не
заменяет.

## Допустимое использование

Автоматизация систем без авторизации, credential stuffing и массовое создание аккаунтов
запрещены. Вы несёте ответственность за соблюдение условий тех сайтов, которые
автоматизируете, и законодательства вашей юрисдикции.

## Ссылки

- Сайт - <https://antibrow.com/ru>
- Документация - <https://antibrow.com/ru/dokumentatsiya>
- Issues - <https://github.com/antibrow/antibrow/issues>
