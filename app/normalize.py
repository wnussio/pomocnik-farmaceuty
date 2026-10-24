"""Normalizacja nazw: wyszukiwanie bez polskich znaków oraz sprowadzanie
nazw substancji (łacińskich, polskich, angielskich) do wspólnego rdzenia.

Przykład: "Amlodipini besilas", "Amlodipinum" i "amlodypina" -> "amlodipin".
"""
import re
import unicodedata

# Słowa opisujące sól, hydrat lub postać surowca roślinnego - nie identyfikują substancji.
IGNORED_WORDS = {
    "hydrochloridum", "dihydrochloridum", "hydrobromidum", "hydrochloride", "chlorowodorek",
    "natricum", "natrii", "kalicum", "kalii", "calcicum", "calicum", "calcii", "magnesicum",
    "fumaras", "sulfas", "hydrosulfas", "hydrogenosulfas", "chloridum", "acetas", "citras",
    "monohydricum", "dihydricum", "dihydricus", "trihydricum", "hexahydricum", "hemihydricum",
    "hemihydricus", "sesquihydricum", "anhydricum", "anhydricus", "succinas", "maleas",
    "propionas", "dipropionas", "besilas", "besilate", "phosphas", "argininum", "nitras",
    "tartras", "furoas", "etexilatum", "cilexetili", "cilexetilum", "medoxomilum", "medoxomili",
    "mesilas", "mesilatum", "tosilas", "dimesylas", "bromidum", "valeras", "xinafoas",
    "acetonidum", "aceponas", "pivalas", "butyras", "lactas", "gluconas", "oxalas", "palmitas",
    "hydrogenosuccinas", "dinatricum", "lysinum", "tert", "butylamini", "erbuminum", "axetili",
    "axetilum", "disoproxilum", "trometamolum", "acidum", "acidi", "herba", "herbae", "extractum",
    "siccum", "tinctura", "intractum", "succus", "folium", "folii", "radix", "radicis", "fructus",
    "flos", "cortex", "aetheroleum", "oleum", "fluidum", "carbonas", "hydroxidum", "oxidum",
    "hydrogenocarbonas", "iodidum", "hydricus", "sodium", "pulvis", "pulveris", "pulverata",
}

_ORTHO = [("ks", "x"), ("th", "t"), ("ph", "f"), ("y", "i"), ("k", "c"), ("w", "v"), ("z", "s")]
_SUFFIXES = ("um", "us", "is", "as", "ae", "a", "e", "i")


def strip_diacritics(text: str) -> str:
    text = text.replace("ł", "l").replace("Ł", "L")
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def simple(text: str) -> str:
    """Małe litery, bez polskich znaków, tylko litery/cyfry rozdzielone spacjami."""
    text = strip_diacritics((text or "").lower())
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def stem(word: str) -> str:
    """Rdzeń pojedynczego słowa, odporny na różnice pisowni PL/łac./ang. i końcówki."""
    w = simple(word).replace(" ", "")
    for a, b in _ORTHO:
        w = w.replace(a, b)
    w = re.sub(r"(.)\1+", r"\1", w)
    for suffix in _SUFFIXES:
        if w.endswith(suffix) and len(w) - len(suffix) >= 3:
            w = w[: -len(suffix)]
            break
    if w.endswith("ic") and len(w) > 5:
        w = w[:-2]
    if w.endswith("i") and len(w) > 3:
        w = w[:-1]
    return w


def substance_tokens(name: str) -> list[str]:
    """Rdzenie słów identyfikujących substancję (bez soli, hydratów itp.)."""
    words = [w for w in simple(name).split() if w.isalpha() and len(w) > 1]
    keep = [w for w in words if w not in IGNORED_WORDS] or words
    return [stem(w) for w in keep]


def substance_key(name: str) -> str:
    return " ".join(substance_tokens(name))


# Popularne polskie nazwy, których nie da się sprowadzić do łacińskiego rdzenia regułami.
POLISH_ALIASES = {
    "kwas acetylosalicylowy": "acidum acetylsalicylicum",
    "aspiryna": "acidum acetylsalicylicum",
    "kwas walproinowy": "acidum valproicum",
    "walproinian": "valproas",
    "kwas foliowy": "acidum folicum",
    "kwas askorbinowy": "acidum ascorbicum",
    "witamina c": "acidum ascorbicum",
    "witamina d": "cholecalciferolum",
    "witamina d3": "cholecalciferolum",
    "kwas alendronowy": "acidum alendronicum",
    "kwas mefenamowy": "acidum mefenamicum",
    "kwas traneksamowy": "acidum tranexamicum",
    "kwas zoledronowy": "acidum zoledronicum",
    "kwas fusydowy": "acidum fusidicum",
    "dziurawiec": "hyperici",
    "lit": "lithium",
    "metamizol": "metamizolum",
    "pyralgina": "metamizolum",
}


def query_tokens(query: str) -> list[str]:
    q = simple(query)
    for pl, latin in POLISH_ALIASES.items():
        if q == pl or q.startswith(pl + " "):
            q = latin + q[len(pl):]
            break
    return substance_tokens(q) if q else []
