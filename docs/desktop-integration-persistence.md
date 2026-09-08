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

## Wyniki testow na VM, 2026-09-08

VM: `steam-mwo-vm2-l4-europe-west3-a`, NVIDIA L4, sterownik `580.178.04`.
Backend: `steam-vm-control-api-00399-rud`, kod `8d7d702`.

| Scenariusz | Wynik |
| --- | --- |
| Restart z GUI | PASS: koncowy status Ready, loader znika |
| Rollback debian do poprzedniego latest | PASS: nowy kontener, zachowane trzy montowania tylko do odczytu |
| Ponowne Apply Update do debian | PASS: nowy kontener, zachowane montowania i preferencje |
| Klawiatura po kazdej z powyzszych operacji | PASS: zdarzenie F8 z urzadzenia Keyboard passthrough odebrane przez okno X11 |
| Domyslna przegladarka po kazdej operacji | PASS: cztery skojarzenia MIME, helper XFCE, uruchomienie Chrome przez exo-open |
| Przeladowanie agenta przed Pull Only | PASS: nowy payload wykonany przed zadaniem, bez wymiany kontenera; hash agenta zgodny z repo |
| Sunshine | PASS: 2026.516.143833, enkodery H.264/HEVC/AV1 NVENC; publiczny HTTPS wymaga uwierzytelnienia (401) |
| noVNC | PASS: lokalny HTTP 200; publiczny port 8083 nie odpowiada w tescie z limitem 5 s |
| Testy lokalne | PASS: 103 testy pytest oraz bash -n dla zmienionych skryptow |

Obrazy uzyte w tescie:

- `debian`: `sha256:1448fd84a47cfb880685d5c01a62f721229a1bbffc44437db32bbb69cb7bccec`
- Poprzedni `latest`: `sha256:0d43c66ad0cf54cb0e51208b30f1f297d78264807661a581691224caa4dec0c0`

Stan koncowy: mwo-vm2 RUNNING na obrazie debian, mwo-vm1 CPU nadal TERMINATED.
Zachowane aplikacje: natywny Steam, Chrome 152.0.7977.82-1, Prism 11.1.0.
Nie kasowano dyskow ani danych. Test klawiatury obejmuje rzeczywisty tor
urzadzenie Sunshine -> evdev -> X11, ale nie stanowi testu pelnej sesji
Moonlight ani fizycznej klawiatury na lokalnym Windows.
