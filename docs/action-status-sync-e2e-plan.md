# Plan zamkniecia testow synchronizacji statusow

Data: 2026-09-10. Baza: `4619370`. Plan i kryteria akceptacji; nie jest to
deklaracja wykonania wszystkich testow. Wyniki biezacego uruchomienia nalezy
raportowac oddzielnie jako PASS, FAIL lub DEFERRED, z podaniem dowodow.

## Cel

Zweryfikowac rzeczywista aktualizacje obrazu i rollback na GPU, synchronizacje
VM Control / Runtime images / Software / Migrations w jednej i wielu kartach
oraz, jesli dostepny jest klient, sesje Moonlight. Nie utozsamiac poprawnego
banera ani inicjalizacji NVENC z pelnym testem streamingu.

## Kolejnosc i ochrona zasobow

1. Potwierdzic wdrozenie, logowanie administratora przez CDP 9222 i stan GCP.
   Zachowac dwie istniejace VM, ich dyski, dane, nazwy i endpointy. Zakaz
   delete/create, wymuszanej migracji i odmontowywania wolumenow tych VM.
2. Przeprowadzic niezalezny review planu, zastosowac uzasadnione uwagi.
3. Wykonac lokalna regresje, dodac testy zidentyfikowanych luk i male poprawki.
   Symulowane odpowiedzi uruchamiac tylko w izolowanym srodowisku bez zapisu
   do API produkcyjnego. Usunac wlasne karty i hooki po testach.
4. Wdrozyc zmienione zasoby frontendowe przez GitHub Pages. Backend wdrazac
   tylko gdy zmieniono jego kod. Sprawdzic faktyczne wersje publicznych plikow.
5. Z GUI wystartowac zatrzymana `mwo-vm2` L4 w `europe-west3-a`.
   Autostop: 1 godzina, najmniejsza wartosc akceptowana przez GUI (min=1,
   krok=1). Nie zakladac obslugi 30 minut. Sprawdzic timer w VM. Po testach
   zatrzymac VM niezaleznie od timera. Nie resetowac terminu kazdym testem.
6. Jesli brakuje GPU w tej strefie, nie przenosic automatycznie istniejacych
   danych. Oznaczyc scenariusz GPU jako DEFERRED, wykonac pozostale testy.
7. Zapisac biezacy i rollback digest, liste aplikacji i gotowosc uslug.
   Sprawdzic cache obrazow przed apply; ograniczyc pobieranie do zaufanych
   kompatybilnych obrazow. Monitorowac postep zamiast uznawac timeout za sukces.
8. Z GUI wykonac apply, reczny rollback do znanego dzialajacego obrazu i
   ponowne apply docelowego obrazu. Sprawdzic wynik agenta, kontener, Sunshine,
   enkodery, zachowanie klawiatury i domyslnej przegladarki. Nie restartowac
   niezaleznych serwerow Minecraft ani nie zmieniac ich danych.
9. Obserwowac dwie karty tego samego endpointu i trzecia innego endpointu.
   Bez recznego Status/reload sprawdzic biezacy i koncowy komunikat, loader,
   aktywnosc przyciskow. Powtorzyc dla powrotu z ukrytej karty i opoznienia API.
10. Software: tylko bezpieczna/idempotentna operacja; bez odinstalowania danych
    uzytkownika. Odswiezenie katalogu wersji jest kontrola negatywna (nie operacja
    VM). Migracje: powiadomienia i filtrowanie testowac izolowanymi fixture;
    nie nazywac tego rzeczywista migracja E2E. Rzeczywista migracja wymaga
    osobnej, jednorazowej VM i uprzednio okreslonego sprzatania.
11. Moonlight: rzeczywiste polaczenie klienta, obraz, dzwiek, klawiatura, mysz.
    Oddzielic pomiar/protokol od ludzkiej oceny obrazu i dzwieku. Brak dostepu
    do klienta oznacza DEFERRED tego etapu, nie niepowodzenie testow GUI.
12. Zatrzymac tylko VM wystartowane w tym przebiegu, zwolnic wlasne rezerwacje,
    zachowac pierwotne dane. Raportowac stan koncowy, wdrozenie i braki testowe.

## Macierz regresji

| Przypadek | Metoda i kryterium |
| --- | --- |
| running -> updated / failed / stopped | Kod rzeczywistego pollera: baner i postep zgodne z odpowiedzia |
| started przed propagacja metadanych | Przez ograniczone okno aktywne odpytywanie zamiast 10 s przerwy |
| pusty odczyt / blad API | Nie kasowac ostatnio potwierdzonego postepu bez nowej odpowiedzi |
| odpowiedz po zmianie endpointu/targetu | Nie zastosowac starej odpowiedzi do nowego wyboru |
| powiadomienie innego endpointu | Nie zmieniac biezacego statusu |
| duplikaty / kolejnosc zdarzen | Zdarzenie tylko wyzwala odczyt; status ustala backend |
| ta sama karta i dwie rozne karty | CustomEvent i rzeczywisty BroadcastChannel; debounce odczytow |
| brak BroadcastChannel | CustomEvent lokalnie, okresowe odczyty w innych kartach |
| zajety / ukryty widok | Ograniczone szybkie ponowienie, odczyt po powrocie do widoku |
| migracja dotykajaca dwoch endpointow | Uniewaznienie widokow bez fallbacku do endpointu Runtime images |
| blad apply i rollback | Bezpieczne odrzucenie nieprawidlowego celu; reczny rollback na VM |
| automatyczny rollback po awarii healthcheck | Izolowany test; nie mylic z recznym rollbackiem na VM |

## Niezalezny review i decyzje

Reviewer: `agy-yolo`, przypiety model `gemini-3.8-flash-high`, sesja
`f28b15e8-8d18-490d-988a-f2d894dfe068`. Odczyt puli przed zleceniem:
minimum 0.7772976756095886, powyzej wymaganego 0.10. Review tylko do odczytu.

- Przyjeto: opoznienie propagacji, odrzucanie odpowiedzi starego targetu,
  reset sledzenia po wyborze endpointu, testy busy/hidden i izolacja fixture.
- Przyjeto: obustronne powiadomienia panelow, lokalny CustomEvent rowniez bez
  BroadcastChannel, powiadomienia zmiany hasla Sunshine i endpointow.
- Doprecyzowano: BroadcastChannel nie wysyla do wlasnego obiektu nadawcy, ale
  drugi obiekt kanalu w tym samym oknie moze odebrac wiadomosc. Nie zakladac,
  ze wszystkie obiekty w oknie sa automatycznie wykluczone.
- Nie dodawac identyfikatorow operacji tylko dla samych powiadomien. Zdarzenia
  nie sa autorytatywnym wynikiem; duplikat lub starsze zdarzenie najwyzej
  wyzwala odczyt. Guard odpowiedzi wedlug endpointu/targetu jest wymagany.
- Zamiast nieobslugiwanego 30-minutowego autostopu: 1 godzina i jawny stop.
- Nie oczekiwac niezaimplementowanego fallbacku localStorage. Zweryfikowac
  degradacje do pollingu; nie mnozyc mechanizmow synchronizacji bez potrzeby.
- Rzeczywisty rollback i syntetyczna awaria healthcheck to osobne wyniki.

## Stan wejsciowy tego przebiegu

- Obie VM TERMINATED, brak rezerwacji GPU.
- Istniejace testy: 123 Python + 5 subtestow, katalog Node 10 sprawdzen,
  synchronizacja Node 12 sprawdzen: PASS przed zmianami.
- Przegladarka CDP dostepna; logowanie Google wymagalo potwierdzenia przez
  uzytkownika i zostalo zakonczone. Windows Moonlight jest zainstalowany;
  jego faktyczne polaczenie pozostaje do sprawdzenia.

## Wyniki realizacji (2026-09-10)

Poprawki zostaly wdrozone i przetestowane lokalnie oraz przez przegladarke.
Rzeczywisty start/stop CPU i synchronizacja kart: PASS. Testy aktualizacji
Sunshine oraz Moonlight wymagajace GPU pozostaja do wykonania z powodu braku
zasobow L4 w strefie istniejacej VM. Obie VM po testach sa TERMINATED.

Szczegoly i granice potwierdzonego zakresu:
[Wyniki E2E z 2026-09-10](action-status-sync-e2e-results-20260910.md).
