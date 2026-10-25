# Pomocnik farmaceuty

> ## ⚠️ Zastrzeżenie – projekt testowy
>
> To **eksperymentalny, prywatny projekt**, w którym sprawdzam, czy da się zbudować takie narzędzie. **Nie jest profesjonalnym oprogramowaniem ani wyrobem medycznym** i nie przeszedł żadnej certyfikacji ani walidacji klinicznej.
>
> - Informacje mają charakter **wyłącznie poglądowy**. Nie zastępują Charakterystyki Produktu Leczniczego (ChPL), ulotki ani oceny farmaceuty lub lekarza.
> - Tabele interakcji, suplementów i ostrzeżeń dla pacjenta to **wersja startowa, niezweryfikowana** przez specjalistę. Mogą być niekompletne lub zawierać błędy.
> - Brak informacji o interakcji **nie oznacza**, że leki można bezpiecznie łączyć.
> - Zakładka „Objawy” **pod żadnym pozorem nie jest poradą medyczną ani diagnozą** – to pomoc w doborze leku bez recepty w rozmowie z pacjentem, tak jak robi to farmaceuta. Przy objawach alarmowych lub braku poprawy pacjent powinien zgłosić się do lekarza.
> - Autor **nie ponosi odpowiedzialności** za decyzje podjęte na podstawie aplikacji ani za skutki jej użycia. Korzystasz na własną odpowiedzialność.

**Aplikacja na telefon:** https://wnussio.github.io/pomocnik-farmaceuty/ · instrukcja instalacji: [`INSTRUKCJA_INSTALACJI.txt`](INSTRUKCJA_INSTALACJI.txt)

## Skąd pochodzą dane

| Dane | Źródło | Aktualizacja |
|---|---|---|
| Leki (nazwy, substancje czynne, moce, postacie, opakowania/EAN, kategorie dostępności, linki do ChPL i ulotek) | [Rejestr Produktów Leczniczych](https://rejestrymedyczne.ezdrowie.gov.pl) – oficjalny, publiczny eksport URPL / e-Zdrowie (XML) | automatycznie co tydzień |
| Interakcje (`data/interakcje.json`) | własna tabela przygotowana na podstawie ogólnodostępnej wiedzy farmakologicznej – **niezweryfikowana** | ręcznie |
| Składniki suplementów (`data/suplementy.json`) | własny katalog – **niezweryfikowany** (brak otwartego rejestru składu suplementów w PL) | ręcznie |
| Ostrzeżenia: wiek (dzieci, seniorzy 65+ – kryteria Beers / STOPP) / ciąża / karmienie (`data/pacjent.json`) | własna tabela – **niezweryfikowana**; progi różnią się między preparatami | ręcznie |
| Ostrzeżenia przy wydaniu: prowadzenie pojazdów, fotouczulenie, żywność (`data/ostrzezenia.json`) | własna tabela – **niezweryfikowana** (na podstawie punktów 4.5 i 4.7 typowych ChPL) | ręcznie |
| Objawy → leki bez recepty, objawy alarmowe (`data/objawy.json`) | własna tabela – **niezweryfikowana**, wersja testowa | ręcznie |
| Refundacja: cena, limit, poziom odpłatności, dopłata pacjenta, bezpłatne S / DZ / C | [obwieszczenie Ministra Zdrowia](https://www.gov.pl/web/zdrowie/obwieszczenia-ministra-zdrowia-lista-lekow-refundowanych) – załącznik XLSX (arkusze A1, D1, D2, E); łączone z rejestrem po kodzie EAN | przy aktualizacji bazy (lista zmienia się co 2–3 miesiące) |
| Skanowanie kodów (iPhone) | biblioteka [ZXing](https://github.com/zxing-js/library) (Apache 2.0) | – |

Aplikacja nie zbiera żadnych danych: lista leków i dane pacjenta zapisują się tylko w przeglądarce/telefonie użytkownika.

## Jak to jest zbudowane

- **Wersja na komputer** (`app/`, `static/`): Python + FastAPI + SQLite, uruchamiana lokalnie.
- **Wersja na telefon** (`pwa/`): aplikacja webowa instalowana z przeglądarki (PWA), działająca **offline**. Ta sama logika (wyszukiwanie, zamienniki, interakcje, ostrzeżenia) przepisana na JavaScript; dane wstępnie przetwarzane przez moduły Pythona. Zgodność obu wersji sprawdza automatyczny test (`pwa/test_parity.py`).
- **Publikacja**: GitHub Actions co tydzień pobiera świeży rejestr, uruchamia testy, buduje aplikację i publikuje ją na GitHub Pages.

## Funkcje

1. **Wyszukaj lek** – po nazwie (z podpowiedziami, tolerancją literówek i braku polskich znaków) lub po kodzie EAN (także ze skanera). Karta leku: substancje czynne z mocą, postać, kategoria dostępności, podmiot odpowiedzialny, opakowania, linki do ChPL i ulotki.
2. **Zamienniki** – wyszukanie substancji czynnej i leków z tym samym składem. Najpierw ta sama moc, potem pozostałe moce od najbliższej. Filtry postaci i drogi podania, opcjonalnie preparaty złożone.
3. **Suplementy** – wybór składnika suplementu diety (magnez, D3, miłorząb, czerwony ryż drożdżowy…) z osobnej wyszukiwarki; trafia na wspólną listę z lekami. Katalog: `data/suplementy.json` (wersja startowa do weryfikacji). Wykrywane jest też dublowanie leku i suplementu (np. Vigantol + suplement D3).
4. **Interakcje** – lista leków i suplementów (przechowywana tylko w przeglądarce) sprawdzana pod kątem interakcji, dublowania substancji i grup terapeutycznych. Można dodać alkohol.
5. **Pacjent** – wiek (przedziały: dorosły, senior 65+, 12–17, 6–11, 2–5 lat, 3 mies.–2 lata, < 3 mies.), ciąża, karmienie piersią. Ostrzeżenia dotyczą każdej pozycji osobno (także leków miejscowych i pojedynczego leku). Reguły: `data/pacjent.json` (wersja startowa do weryfikacji; korzysta z grup z `interakcje.json` + własnych). „Wyczyść listę” resetuje też dane pacjenta.
6. **Objawy** (wersja testowa, nie jest poradą medyczną) – wybór objawu (np. ból głowy, kaszel, biegunka): najpierw pytania do pacjenta i objawy alarmowe („skieruj do lekarza”), potem możliwe substancje bez recepty z listą leków OTC z rejestru. Każda podpowiedź jest sprawdzana z listą leków pacjenta (interakcje), jego profilem (wiek, ciąża, karmienie) i ostrzeżeniami przy wydaniu.
7. **Ostrzeżenia przy wydaniu** – na karcie leku i na liście: prowadzenie pojazdów, fotouczulenie (słońce), interakcje z żywnością i napojami (nabiał, grejpfrut, tyramina, witamina K, alkohol z metronidazolem…).
8. **Refundacja** – na liście wyników „Ref. od X zł” i oznaczenia S / DZ / C; na karcie leku dla każdego opakowania: cena detaliczna, limit, zakresy wskazań z poziomem odpłatności i dopłatą pacjenta.

## Uruchomienie

Wymagany Python 3.11+.

- **Na co dzień:** skrót **„Pomocnik farmaceuty”** (w folderze projektu; można go skopiować na pulpit). Aplikacja startuje w tle bez okna konsoli, sama otwiera przeglądarkę i **sama się wyłącza po zamknięciu wszystkich kart** (ok. 15 s po zamknięciu). Ponowne kliknięcie skrótu, gdy aplikacja działa, otwiera tylko nową kartę. Przy pierwszym uruchomieniu rejestr leków pobiera się automatycznie (postęp widać w aplikacji). Log: `data/aplikacja.log`.
- **Pierwsza instalacja / po aktualizacji zależności:** `start.bat` (instaluje pakiety i uruchamia aplikację w tle).
- **Ręcznie (tryb deweloperski, z konsolą):**

```
pip install -r requirements.txt
python -m app.importer            # pierwszy import rejestru (pobiera go, jeśli brak)
python -m uvicorn app.main:app --port 8000
```

Następnie otwórz http://127.0.0.1:8000.

## Wersja na telefon (PWA, działa offline)

Folder `pwa/` – ta sama funkcjonalność jako strona instalowana na telefonie („Dodaj do ekranu głównego”), działająca bez internetu, ze skanowaniem kodów EAN aparatem.

- `pwa/src/` – interfejs (`index.html`, `app.js`, `style.css`), silnik `engine.js` (port logiki z `app/`), service worker `sw.js`, skaner dla iPhone'ów `vendor/zxing.min.js` (Apache 2.0).
- `python -m pwa.build [--pobierz]` – buduje `pwa/dist/` (dane wstępnie przetworzone przez moduły z `app/`; ok. 10 MB w telefonie, ok. 2 MB do pobrania).
- `python -m pwa.test_parity` – sprawdza, że silnik JavaScript daje identyczne wyniki jak Python (wymaga Edge/Chrome).
- Publikacja: GitHub Actions (`.github/workflows/pwa.yml`) buduje i publikuje na GitHub Pages po każdej zmianie oraz co poniedziałek ze świeżym rejestrem. Telefon pokazuje wtedy „Dostępna nowa wersja bazy leków – Odśwież”.

## Dane

- **Refundacja**: `python -m app.refund [--pobierz]` – pobiera najnowsze obwieszczenie MZ z gov.pl do `data/raw/refundacja.xlsx` i tworzy `data/refundacja.json` (pobiera się też przy „Aktualizuj bazę leków”). Uwzględniane jest obwieszczenie główne – obwieszczenia zmieniające i sprostowania w trakcie okresu nie są wczytywane.
- **Leki**: [Rejestr Produktów Leczniczych](https://rejestrymedyczne.ezdrowie.gov.pl) (URPL, eksport XML 6.0.0), tylko produkty ludzkie. Aktualizacja przyciskiem „Aktualizuj bazę leków” w aplikacji lub komendą `python -m app.importer --pobierz`.
- **Interakcje**: `data/interakcje.json` – **wersja startowa do weryfikacji przez farmaceutę**. Plik jest edytowalny:
  - `grupy` – substancje (łacińska nazwa, jedno słowo identyfikujące, np. `"Warfarinum"`) i/lub prefiksy ATC (np. `"M01AE"`); opcjonalnie `w_obrebie_grupy` dla dwóch różnych leków z tej samej grupy,
  - `reguly` – para grup `a` + `b`, `poziom` (`przeciwwskazane` / `istotna` / `niewielka`), `opis`, `zalecenie`.
  - Po edycji: restart aplikacji albo `POST /api/interakcje/przeladuj`. Błędy w pliku (np. nieistniejąca grupa) są zgłaszane przy wczytaniu.

Leki o działaniu wyłącznie miejscowym (na skórę, do oka, donosowo…) są pomijane w analizie interakcji ogólnoustrojowych.

## Testy

```
python -m pytest
```
