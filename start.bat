@echo off
rem Instaluje zaleznosci i uruchamia aplikacje w tle (bez okna konsoli).
rem Na co dzien wygodniej uzywac skrotu "Pomocnik farmaceuty".
cd /d "%~dp0"
python -m pip install -q -r requirements.txt
start "" pythonw -m app.launcher
