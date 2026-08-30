# Plan automatycznego startu VM po rezerwacji GPU

## Cel

Po znalezieniu i utrzymaniu zgodnej rezerwacji GPU dla zaznaczonej opcji
`Start selected VM using reserved GPU capacity` modal startu ma dać użytkownikowi
30 sekund na zmianę decyzji. Jeżeli użytkownik nie wykona żadnej akcji, aplikacja
automatycznie uruchomi tę samą operację, którą wykonałby główny przycisk modala:
zwykły Start w tej samej strefie albo migrację i Start w innej strefie.

## Zakres

1. Zachować obecne API, workflow rezerwacji oraz rozgałęzienie `start` /
   `relocate-start` bez zmian.
2. Rozszerzyć wyłącznie modal `start-reserved-dialog` i funkcję
   `selectReservedStart()`.
3. Nie dodawać odliczania do modala Create ani do ręcznego startu bez aktywnej
   rezerwacji GPU.

## Zachowanie GUI

1. Po otwarciu modala wyświetlić komunikat z odliczaniem od 30 do 0 sekund.
2. Tekst ma jednoznacznie opisywać oczekiwany skutek:
   - `Starting automatically in N seconds` dla tej samej strefy,
   - `Migrating and starting automatically in N seconds` dla innej strefy.
3. Po dojściu do zera zamknąć modal z wartością `start`, wykorzystując istniejącą
   ścieżkę obsługi Start/migracji i nadal aktywną rezerwację.
4. Każde jawne działanie użytkownika w modalu zatrzymuje odliczanie przed
   wykonaniem decyzji: główny Start, kontynuowanie skanu, Pause, Cancel oraz
   zamknięcie modala klawiszem Escape.
5. Po ręcznym Start nie wykonywać drugiego automatycznego Start.
6. Po Pause, Cancel lub kontynuowaniu skanu zachować istniejącą procedurę
   zwolnienia rezerwacji.
7. Timer nie może działać po zamknięciu modala ani po otwarciu kolejnego modala.

## Implementacja

1. Dodać do `admin.html` element `aria-live="polite"` pokazujący odliczanie.
2. W `selectReservedStart()`:
   - inicjalizować deadline na podstawie `Date.now() + 30_000`,
   - renderować pozostałe pełne sekundy na podstawie deadline, zamiast
     dekrementować licznik, aby ograniczyć dryf po przycięciu timerów karty,
   - aktualizować widok co najwyżej raz na sekundę,
   - przed automatycznym zatwierdzeniem sprawdzić, czy modal nadal jest otwarty
     i czy decyzja nie została już podjęta,
   - zamknąć modal przez `dialog.close("start")`, bez duplikowania logiki Start.
3. Użyć jednej funkcji `settleReservedStart(action)` do atomowego rozstrzygnięcia
   `submit`, `cancel`, `close` i timeoutu, zatrzymania timerów, usunięcia
   listenerów oraz zamknięcia modala dokładnie raz.
4. Przed każdym `showModal()` wyzerować `dialog.returnValue`; klawisz Escape
   jawnie mapować na `pause`, aby nie odziedziczyć poprzedniego `start`.
5. Przed autostartem potwierdzić, że aktywny workflow nadal ma ten sam
   `workflowId`, `preparationToken`, źródłową VM, hardware i strefę.
6. Porównać 30-sekundowy deadline z `expiresAt`. Autostart jest dostępny tylko,
   gdy po odliczaniu pozostaje co najmniej 5 sekund na przejęcie workflow.
   Przy krótszym TTL modal pozostaje do ręcznej decyzji i pokazuje ostrzeżenie.
7. Zablokować wyścig pomiędzy kliknięciem przycisku a wygaśnięciem timera za
   pomocą lokalnej flagi rozstrzygnięcia.
8. Czas jest czasem ściennym: po powrocie do karty działającej w tle autostart
   następuje niezwłocznie, jeżeli 30 sekund minęło i workflow nadal jest ważny.
9. Zaktualizować cache-buster `app.js` w `admin.html`.

## Testy

1. Test kontraktowy HTML/JavaScript:
   - modal zawiera dostępny element odliczania,
   - czas wynosi 30 sekund,
   - automatyczna decyzja korzysta z `dialog.close("start")`,
   - obsługa `close` czyści timer,
   - ścieżka nadal rozróżnia Start lokalny i migrację ze Start.
2. E2E w przeglądarce przez CDP `9222`:
   - otwarcie modala dla aktywnej rezerwacji pokazuje 30 sekund i malejący czas,
   - ręczne Cancel/Pause/continue zatrzymuje timer i nie uruchamia VM,
   - ręczny Start nie powoduje podwójnego żądania,
   - brak reakcji powoduje dokładnie jedno zatwierdzenie po około 30 sekundach,
   - scenariusz tej samej strefy wykonuje Start bez migracji,
   - scenariusz innej strefy wykonuje migrację i Start.
3. Regresja: modal Create, ręczne wyniki skanu i sprzątanie rezerwacji zachowują
   dotychczasowe działanie.
4. Przypadki graniczne: ręczny Start równocześnie z timeoutem, Escape po
   wcześniejszym użyciu modala, ponowne otwarcie modala, zmiana aktywnego
   workflow, zbyt krótki TTL i karta działająca w tle. Każdy przypadek może
   rozstrzygnąć modal najwyżej raz.
5. Potwierdzić dokładnie jedno żądanie `/api/command` dla tej samej strefy albo
   jedną sekwencję `prepare`/`start` dla migracji oraz brak odliczania w Create.

## Wynik niezależnego review

Niezależny audyt wykrył ryzyko starego `dialog.returnValue`, wyścig timera z
kliknięciem, możliwość zatwierdzenia nieaktualnego workflow i brak kontroli TTL.
Wszystkie te uwagi przyjęto powyżej. Audyt kontraktu backendowego potwierdził,
że podpisany token wiąże operację, endpoint, hardware, strefę i źródłową VM;
backend ponownie wymaga aktywnego stanu `HELD`, atomowo przejmuje workflow,
wydłuża deadline po przejęciu oraz ma procedury zwolnienia po odrzuceniu,
błędzie migracji i wygaśnięciu. Dzięki temu zmiana pozostaje frontendowa.

## Wdrożenie i kryteria akceptacji

1. Wdrożyć statyczny frontend standardową ścieżką GitHub Pages; backend nie
   wymaga wdrożenia, jeżeli review nie wykaże potrzeby zmiany kontraktu.
2. Potwierdzić w wersji wdrożonej, że odliczanie jest widoczne i operacja
   kończy się pojedynczym Start lub `relocate-start`.
3. Po testach zwolnić rezerwacje testowe i nie pozostawić niezamierzonych
   działających VM.
