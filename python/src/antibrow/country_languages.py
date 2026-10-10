"""Exit country to ``navigator.languages``.

Mirrors the JS SDK's country table; ``tests/test_country_languages.py`` reads
that file and fails when the two drift.
"""

from __future__ import annotations

from typing import Dict, List, Optional

#: Country code -> Accept-Language, same strings as the JS SDK.
COUNTRY_ACCEPT_LANGUAGE: Dict[str, str] = {
    "US": "en-US,en;q=0.9",
    "GB": "en-GB,en;q=0.9",
    "AU": "en-AU,en;q=0.9",
    "CA": "en-CA,en;q=0.9,fr;q=0.8",
    "NZ": "en-NZ,en;q=0.9",
    "IE": "en-IE,en;q=0.9",
    "ZA": "en-ZA,en;q=0.9",
    "IN": "en-IN,en;q=0.9,hi;q=0.8",
    "SG": "en-SG,en;q=0.9,zh;q=0.8",
    "PH": "en-PH,en;q=0.9",
    "NG": "en-NG,en;q=0.9",
    "KE": "en-KE,en;q=0.9",
    "GH": "en-GH,en;q=0.9",
    "DE": "de-DE,de;q=0.9,en;q=0.8",
    "AT": "de-AT,de;q=0.9,en;q=0.8",
    "CH": "de-CH,de;q=0.9,fr;q=0.8,en;q=0.7",
    "FR": "fr-FR,fr;q=0.9,en;q=0.8",
    "BE": "fr-BE,fr;q=0.9,nl;q=0.8,en;q=0.7",
    "LU": "fr-LU,fr;q=0.9,de;q=0.8,en;q=0.7",
    "ES": "es-ES,es;q=0.9,en;q=0.8",
    "MX": "es-MX,es;q=0.9,en;q=0.8",
    "AR": "es-AR,es;q=0.9,en;q=0.8",
    "CO": "es-CO,es;q=0.9,en;q=0.8",
    "CL": "es-CL,es;q=0.9,en;q=0.8",
    "PE": "es-PE,es;q=0.9,en;q=0.8",
    "VE": "es-VE,es;q=0.9,en;q=0.8",
    "EC": "es-EC,es;q=0.9,en;q=0.8",
    "UY": "es-UY,es;q=0.9,en;q=0.8",
    "PY": "es-PY,es;q=0.9,en;q=0.8",
    "BO": "es-BO,es;q=0.9,en;q=0.8",
    "CR": "es-CR,es;q=0.9,en;q=0.8",
    "PA": "es-PA,es;q=0.9,en;q=0.8",
    "DO": "es-DO,es;q=0.9,en;q=0.8",
    "GT": "es-GT,es;q=0.9,en;q=0.8",
    "CU": "es-CU,es;q=0.9,en;q=0.8",
    "HN": "es-HN,es;q=0.9,en;q=0.8",
    "SV": "es-SV,es;q=0.9,en;q=0.8",
    "NI": "es-NI,es;q=0.9,en;q=0.8",
    "PR": "es-PR,es;q=0.9,en;q=0.8",
    "PT": "pt-PT,pt;q=0.9,en;q=0.8",
    "BR": "pt-BR,pt;q=0.9,en;q=0.8",
    "IT": "it-IT,it;q=0.9,en;q=0.8",
    "NL": "nl-NL,nl;q=0.9,en;q=0.8",
    "RU": "ru-RU,ru;q=0.9,en;q=0.8",
    "UA": "uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7",
    "BY": "ru-BY,ru;q=0.9,en;q=0.8",
    "KZ": "ru-KZ,kk;q=0.9,ru;q=0.8,en;q=0.7",
    "UZ": "uz-UZ,ru;q=0.9,en;q=0.8",
    "PL": "pl-PL,pl;q=0.9,en;q=0.8",
    "CZ": "cs-CZ,cs;q=0.9,en;q=0.8",
    "SK": "sk-SK,sk;q=0.9,en;q=0.8",
    "HU": "hu-HU,hu;q=0.9,en;q=0.8",
    "RO": "ro-RO,ro;q=0.9,en;q=0.8",
    "BG": "bg-BG,bg;q=0.9,en;q=0.8",
    "HR": "hr-HR,hr;q=0.9,en;q=0.8",
    "RS": "sr-RS,sr;q=0.9,en;q=0.8",
    "SI": "sl-SI,sl;q=0.9,en;q=0.8",
    "LT": "lt-LT,lt;q=0.9,en;q=0.8",
    "LV": "lv-LV,lv;q=0.9,en;q=0.8",
    "EE": "et-EE,et;q=0.9,en;q=0.8",
    "SE": "sv-SE,sv;q=0.9,en;q=0.8",
    "NO": "nb-NO,nb;q=0.9,no;q=0.8,en;q=0.7",
    "DK": "da-DK,da;q=0.9,en;q=0.8",
    "FI": "fi-FI,fi;q=0.9,en;q=0.8",
    "IS": "is-IS,is;q=0.9,en;q=0.8",
    "JP": "ja-JP,ja;q=0.9,en;q=0.8",
    "KR": "ko-KR,ko;q=0.9,en;q=0.8",
    "CN": "zh-CN,zh;q=0.9,en;q=0.8",
    "TW": "zh-TW,zh;q=0.9,en;q=0.8",
    "HK": "zh-HK,zh;q=0.9,en;q=0.8",
    "MO": "zh-MO,zh;q=0.9,en;q=0.8",
    "MN": "mn-MN,mn;q=0.9,en;q=0.8",
    "TH": "th-TH,th;q=0.9,en;q=0.8",
    "VN": "vi-VN,vi;q=0.9,en;q=0.8",
    "ID": "id-ID,id;q=0.9,en;q=0.8",
    "MY": "ms-MY,ms;q=0.9,en;q=0.8",
    "MM": "my-MM,my;q=0.9,en;q=0.8",
    "KH": "km-KH,km;q=0.9,en;q=0.8",
    "LA": "lo-LA,lo;q=0.9,en;q=0.8",
    "TR": "tr-TR,tr;q=0.9,en;q=0.8",
    "SA": "ar-SA,ar;q=0.9,en;q=0.8",
    "AE": "ar-AE,ar;q=0.9,en;q=0.8",
    "EG": "ar-EG,ar;q=0.9,en;q=0.8",
    "IQ": "ar-IQ,ar;q=0.9,en;q=0.8",
    "JO": "ar-JO,ar;q=0.9,en;q=0.8",
    "KW": "ar-KW,ar;q=0.9,en;q=0.8",
    "QA": "ar-QA,ar;q=0.9,en;q=0.8",
    "BH": "ar-BH,ar;q=0.9,en;q=0.8",
    "OM": "ar-OM,ar;q=0.9,en;q=0.8",
    "LB": "ar-LB,ar;q=0.9,fr;q=0.8,en;q=0.7",
    "IL": "he-IL,he;q=0.9,en;q=0.8",
    "IR": "fa-IR,fa;q=0.9,en;q=0.8",
    "PK": "ur-PK,ur;q=0.9,en;q=0.8",
    "BD": "bn-BD,bn;q=0.9,en;q=0.8",
    "LK": "si-LK,si;q=0.9,en;q=0.8",
    "NP": "ne-NP,ne;q=0.9,en;q=0.8",
    "GR": "el-GR,el;q=0.9,en;q=0.8",
    "CY": "el-CY,el;q=0.9,en;q=0.8",
    "GE": "ka-GE,ka;q=0.9,en;q=0.8",
    "AM": "hy-AM,hy;q=0.9,en;q=0.8",
    "AZ": "az-AZ,az;q=0.9,en;q=0.8",
    "MA": "ar-MA,ar;q=0.9,fr;q=0.8,en;q=0.7",
    "DZ": "ar-DZ,ar;q=0.9,fr;q=0.8,en;q=0.7",
    "TN": "ar-TN,ar;q=0.9,fr;q=0.8,en;q=0.7",
    "LY": "ar-LY,ar;q=0.9,en;q=0.8",
}


def languages_for_country(country_code: str) -> Optional[List[str]]:
    """``navigator.languages`` for an exit country, None when unlisted.

    The first tag is what the kernel takes as its UI locale, and on macOS it
    aborts at startup unless that names a shipped locale pack exactly - so it is
    resolved the way Chromium picks a pack for a system locale.
    """
    accept = COUNTRY_ACCEPT_LANGUAGE.get(country_code.upper())
    if accept is None:
        return None
    tags = [tag.split(";")[0].strip() for tag in accept.split(",")]
    return list(dict.fromkeys([chrome_locale(tags[0])] + tags[1:]))


CHROME_LOCALES = frozenset(
    (
        "af am ar bg bn ca cs da de el en-GB en-US es es-419 et fa fi fil fr gu he hi hr hu id it ja kn ko "
        "lt lv ml mr ms nb nl pl pt-BR pt-PT ro ru sk sl sr sv sw ta te th tr uk ur vi zh-CN zh-TW"
    ).split()
)

_ALIAS = {"no": "nb", "nn": "nb", "iw": "he", "tl": "fil"}


def chrome_locale(tag: str) -> str:
    """The locale pack Chromium's own resolution lands on for a BCP 47 tag."""
    if tag in CHROME_LOCALES:
        return tag
    parts = tag.lower().split("-")
    lang = parts[0]
    region = parts[1].upper() if len(parts) > 1 else ""
    if lang == "en":
        return "en-GB" if region in ("AU", "CA", "IN", "NZ", "ZA") else "en-US"
    if lang == "es":
        return "es" if region in ("", "ES") else "es-419"
    if lang == "pt":
        return "pt-BR" if region == "BR" else "pt-PT"
    if lang == "zh":
        return "zh-TW" if region in ("HK", "MO", "TW") else "zh-CN"
    base = _ALIAS.get(lang, lang)
    return base if base in CHROME_LOCALES else "en-US"
