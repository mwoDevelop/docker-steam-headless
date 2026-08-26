# Plan obsługi skanowania GPU przy aktywnej VM

## Cel

Zapewnić poprawne i jednoznaczne zachowanie skanerów GPU, gdy działająca VM
zużywa jedyną dostępną jednostkę GPU quota. Brak wolnego quota nie może być
raportowany jako brak pojemności w strefie ani powodować skanowania kolejnych
par GPU/strefa.

## Zakres

- skan wybranych GPU w zgodnych strefach,
- skan wszystkich GPU w wybranej strefie,
- skan wszystkich GPU we wszystkich strefach,
- ręczne `Reserve GPU` dla wyniku zatrzymanego skanu,
- `Reserve Selected GPU Capacity`,
- automatyczny hold dla `Create` i `Start`,
- anulowanie, timeout i globalne zwalnianie rezerwacji.

## Zachowanie docelowe

1. Backend klasyfikuje osobno: brak quota, limit zapytań API, brak pojemności,
   konsumpcję sondy przez inną VM i pozostałe błędy.
2. Brak pojemności dotyczy tylko sprawdzanej pary i skan może przejść dalej.
3. Brak quota oraz rate limit zatrzymują skan. Wynik nie jest oznaczany jako
   niedostępność GPU w strefie.
4. Jeżeli brak quota zbiega się z działającą zarządzaną VM GPU, GUI pyta o jej
   zatrzymanie. Odmowa nie zmienia VM i kończy skan kontrolowanym komunikatem.
5. Po potwierdzeniu backend zatrzymuje wszystkie działające zarządzane VM GPU,
   czeka na stan `TERMINATED` i dopiero wtedy ponawia tę samą sondę.
6. Każda utworzona sonda jest odczytywana z GCE przed uznaniem jej za wolną.
   `inUseCount > 0` oznacza konflikt, a nie dostępność dla nowej VM.
7. Admission lock Firestore nadal gwarantuje tylko jeden utrzymywany workflow,
   natomiast kontrola działających VM chroni quota zajęte poza tym lockiem.

## Decyzja o typie rezerwacji

Rezerwacje pozostają automatycznie konsumowalne. Specyficznej rezerwacji nie
można usunąć, gdy konsumuje ją działająca VM, co kolidowałoby z obecnym
krótkotrwałym workflow. Ryzyko przejęcia rezerwacji ogranicza obowiązkowy
odczyt `inUseCount == 0` przed stanem `HELD`; po uruchomieniu istniejąca
walidacja `reservationConsumptionInfo` potwierdza właściwego konsumenta.

## Testy

1. Jednostkowo sprawdzić klasyfikację quota, rate limit i capacity.
2. Sprawdzić odrzucenie sondy już konsumowanej przez istniejącą VM.
3. Sprawdzić kontrakt wszystkich wywołań rezerwacji w GUI.
4. E2E przez CDP 9222: działająca VM GPU, skan, odmowa zatrzymania, ponowienie,
   potwierdzenie zatrzymania, retry tej samej pary oraz cleanup.
5. Regresyjnie sprawdzić skan bez działającej VM, ręczny hold, anulowanie i
   licznik rezerwacji równy zero po zakończeniu.

