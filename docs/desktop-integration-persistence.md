# Trwale poprawki pulpitu po aktualizacji obrazu

## Przyczyna

Regula Xorg dla klawiatury Sunshine byla zapisywana przez docker exec tylko
w warstwie kontenera. Aktualizacja obrazu lub rollback tworzy nowy kontener,
przez co regula znikala. XFCE dodatkowo wybieral swoj pomocniczy launcher
przegladarki, wskazujacy Firefox, mimo zainstalowanego Chrome.

## Rozwiazanie

- Agent VM generuje pliki w hostowym katalogu
  /opt/container-services/steam-headless/desktop-integration.
- Osobny override Compose montuje regule klawiatury i pomocnika Chrome
  tylko do odczytu oraz rejestruje autostart dla sesji pulpitu.
- Startup VM i kazda wymiana kontenera (takze rollback) korzystaja z tego
  samego generatora w power-action.sh.
- Pomocnik uruchomiony jako uzytkownik pulpitu aktualizuje skojarzenia
  HTTP/HTTPS/HTML/XHTML oraz pomocnika WebBrowser w XFCE.
- Bez zainstalowanego Chrome preferencje pozostaja bez zmian.
- Po instalacji Chrome pomocnik i jego autostart sa dodatkowo zapisywane
  w trwalym katalogu domowym, takze w starszej sciezce instalatora.
- Aktualizacja obrazu oczekuje na pulpit i uzgodnienie preferencji przed
  oznaczeniem operacji jako zakonczonej.

Zrodla upstream nie wymagaja modyfikacji. Konfiguracja zostaje odtworzona
takze po uruchomieniu VM z nowym dyskiem startowym przez obecny backend.

## Testy akceptacyjne

1. Bez Chrome: brak zmian preferencji.
2. Z Chrome: skojarzenia MIME i XFCE wskazuja Chrome; inne ustawienia sa zachowane.
3. Powtorzenie konfiguracji oraz zasymulowany reset preferencji przez obraz.
4. Aktualizacja i rollback na mwo-vm2: nowy kontener zachowuje montowania,
   Xorg wykorzystuje evdev dla Keyboard passthrough, Sunshine jest Ready.
5. Restart VM: te same ustawienia, poprawny ekran i enkodery Sunshine.
6. Test zdarzenia klawiatury na warstwie X11 z wirtualnego urzadzenia Sunshine.

Test na zywej VM wykryl plaski format helpers.rc (bez sekcji INI).
Pomocnik zachowuje ten format i pozostale preferencje XFCE. Startup stosuje
stary override Sunshine tylko wtedy, gdy zostal wlaczony dla aktualnego
obrazu, zamiast sugerowac sie pozostaloscia pliku po poprzednim obrazie.

Aktualizacja pliku agenta nie zmienia funkcji juz zaladowanych do procesu
Bash. Dlatego startup restartuje usluge agenta po atomowej instalacji pliku.
Agent sprawdza nowy payload przed kolejna akcja i przeladowuje sie, jezeli
kod sie zmienil. Nie przerywa trwajacej operacji; odrzuca niepoprawny skladniowo
payload bez nadpisywania dzialajacego pliku.
