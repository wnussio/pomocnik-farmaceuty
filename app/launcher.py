"""Uruchamianie aplikacji w tle (bez okna konsoli) z automatycznym zamknięciem.

    pythonw -m app.launcher

Otwiera przeglądarkę dopiero, gdy serwer odpowiada. Serwer kończy pracę, gdy wszystkie
karty aplikacji zostaną zamknięte (brak sygnałów życia ze strony).
"""
import logging
import sys
import threading
import time
import urllib.request
import webbrowser

from . import importer

HOST, PORT = "127.0.0.1", 8000
URL = f"http://{HOST}:{PORT}/"
LOG_PATH = importer.DATA_DIR / "aplikacja.log"

CLOSE_GRACE = 15      # s po zamknięciu karty (czas na odświeżenie strony / inne karty)
IDLE_TIMEOUT = 150    # s bez sygnału życia (karty w tle są przez przeglądarkę usypiane do 1 sygnału/min)


def _server_responds(timeout: float = 1.0) -> bool:
    try:
        urllib.request.urlopen(URL + "api/status", timeout=timeout)
        return True
    except OSError:
        return False


def _open_browser_when_ready() -> None:
    for _ in range(300):
        if _server_responds():
            webbrowser.open(URL)
            return
        time.sleep(0.2)
    logging.error("Serwer nie odpowiedział w ciągu minuty - przeglądarka nie została otwarta")


def _watchdog(server, activity: dict, update_status: dict) -> None:
    while not server.should_exit:
        time.sleep(2)
        if update_status["trwa"]:
            continue
        now = time.monotonic()
        closing_at = activity["closing_at"]
        if (closing_at and now - closing_at > CLOSE_GRACE) or now - activity["last_seen"] > IDLE_TIMEOUT:
            logging.info("Brak otwartych kart aplikacji - zamykanie serwera")
            server.should_exit = True


def main() -> None:
    if _server_responds():
        webbrowser.open(URL)  # aplikacja już działa - wystarczy nowa karta
        return

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    log_file = open(LOG_PATH, "w", encoding="utf-8", buffering=1)
    if sys.stdout is None or sys.stderr is None:  # pythonw nie ma konsoli
        sys.stdout = sys.stderr = log_file
    logging.basicConfig(stream=log_file, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    import uvicorn
    from .main import activity, app, start_update, state, update_status

    if not state["store"].loaded:
        start_update()  # pierwsze uruchomienie: pobranie rejestru w tle, postęp widoczny na stronie

    server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=PORT, log_config=None))
    threading.Thread(target=_open_browser_when_ready, daemon=True).start()
    threading.Thread(target=_watchdog, args=(server, activity, update_status), daemon=True).start()
    server.run()


if __name__ == "__main__":
    main()
