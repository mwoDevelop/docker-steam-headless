# Dalszy plan naprawy ryzyka

> Szczegółowy i aktualny plan walidacji, instalowania oraz usuwania dodatków
> Minecraft znajduje się w
> [planie kompatybilności dodatków Minecraft](./plan-kompatybilnosci-dodatkow-minecraft.md).
> W przypadku rozbieżności ten dedykowany dokument zastępuje zakres fazy 2
> niniejszego planu.

## Zamiar

Zajmij się dodatkowymi elementami wykrytymi podczas dodawania wielu serwerów
Zarządzanie Minecraft Modrinth i naprawa kompilacji obrazu Arch. Praca jest
celowo podzielone na niezależnie wdrażalne zmiany. Żadna faza nie może być zaakceptowana
że stan użytkownika jest wartością metadanych lub przesłaną do wiadomości o czasie działania
poprawność.

## Bieżące wydanie

1. Treść Minecrafta jest teraz przechowywana w każdym wpisie `vm-minecraft-servers`.
Starsze maszyny wirtualne mogą nadal mieć starszą wersję globalną
Wartość `vm-minecraft-modrinth-content`. Rejestr, który już istnieje, ale
nie ma zawartości na serwerze, ukryłoby tę starszą wartość.
2. Wyszukiwarka Modrinth filtruje projekty według wersji gry i kategorii modułu ładującego. The
faktyczna wersja do pobrania jest sprawdzana podczas instalacji. Projekt może
nadal istnieje w kategorii, ale brakuje im artefaktu do pobrania dla konkretnej gry
Wersja i moduł ładujący.
3. Kompilacja obrazu jest zielona po dostępnym w handlu detalicznym `ttf-msfonts`, ale CI
raportuje o wycofaniu Node.js 20 dla przypiętych akcji GitHub i
Ostrzeżenia `SecretsUsedInArgOrEnv` dotyczące domyślnych wartości środowiska haseł w
oba pliki Dockerfile.
4. Lokalna weryfikacja Dockera jest niedostępna w bieżącej sesji WSL, ponieważ
`/var/run/docker.sock` jest nieobecny. To kwestia środowiska, a nie choroby
obraz lub rozwiązanie źródłowe.

## Bez bramek

- Nie migruj ani nie usuwaj metadanych wirtualnych maszyn bez zweryfikowanej kopii zapasowej i a
deterministyczne mapowanie serwerów.
- Nie ujawniaj w Internecie tajemnic RCON Minecrafta ani tajemnic elektrycznych.
- Nie zastępuj przypiętych akcji GitHub pływającymi tagami.
- Nie zmieniaj wdrożonych danych uwierzytelniających Steam, Sunshine lub Minecraft w ramach
zachowanie ostrzeżenia o obrazie.

## Niezależny przegląd planu i umieść

Plan początkowy został zweryfikowany jako zmiana produkcyjna z współbieżną maszyną wirtualną
działania, dane zgłoszenia i publikacja CI w zakresie. Artykuł
wykryto luki, które zostały usunięte za pomocą poprawki poprawek.

1. **Migracja metadanych może być widoczna wraz z aktywną akcją dotyczącą treści.** Kopia do odczytu-
migracja zapisu bez metadanych odcisku palca może być plikiem a
nowy wynik agenta lub inna akcja administratora. dlatego migracja musi
działanie zabezpieczające na poziomie podstawowym i współbieżności/ponawiania prób w oparciu o
odcisk palca metadanych Compute Engine.
2. **Rejestr może nie być ujawniony prawdy w czasie wykonywania.** Przed a
ryzyko, które powoduje uszkodzenie skryptów uruchamiających wirtualną maszynę i agenta zarządzania
rejestr, metadane starszej zawartości i wygenerowane manifesty. Emigracja
nie można usunąć ani aktualizacji starszego klucza, jeśli metody wykonania nie zostały zmienione
dostępne, że korzystasz z rejestru dla serwera.
3. **Wyszukiwanie kategorii modułu ładującego nie jest zatwierdzone przez kompatybilności.** Dokładne
Sprawdzanie wersji Modrinth musi także odrzucać artefakty dostępne tylko dla klienta i inne
Wybrana nazwa pliku i suma kontrolna dla agenta wirtualnej maszyny do późniejszej weryfikacji
pobierać.
4. **Weryfikacja na podstawie wyniku może spowodować obciążenie interfejsu API.** Wyszukiwanie wymaga a
ograniczona współbieżność, podręczna, aktualna terminacja i polityka wyników częściowych
więc awaria lub odpowiedź 429 nie powoduje zawieszenia stronyj.
5. **Ostrzeżenia dotyczące bezpieczeństwa CI mają różne znaczenie.** Wartość domyślna zastępcza
i wdrożony sekret nie są równoważne. Projekt musi najpierw zostać podłączony
w obrazie nie są ujawnione dane uwierzytelniające produkty, należy je usunąć lub odizolować
symbole zastępcze bez zmiany ustawień środowiska wykonawczego.
6. ** Pomyślny test CI nie może po cichu publikować nierecenzowanej produkcji
tag.** Weryfikacja zależności i pliku Dockerfile wymaga niepublikowania PR lub
ścieżki licznika testowego przed opublikowaniem `latest` w wersji głównej.

## Faza 0: Linia bazowa i bramka bezpieczeństwa

### Analiza

1. Zinwentaryzuj każdy aktywny punkt końcowy i przeczytaj, bez mutacji:
- `vm-minecraft-servers`
- `vm-minecraft-modrinth-content`
- identyfikator serwera Minecraft, środowisko wykonawcze, wersja, stan i lista zawartości
2. Sklasyfikuj każdą maszynę wirtualną jako jeden z:
- starszy singleton: brak rejestru serwerów, do którego może należeć zawartość globalna
     `default`
- jednoznaczny rejestr: dokładnie jeden nieusunięty serwer ze starszą zawartością
- niejednolity rejestr: wiele nieusuniętych serwerów ze starszą zawartością
- już przeniesione: treść odbierana tylko w rejestrze
3. Przed zabezpieczeniem migracji zapisz kopii zapasowej metadanych ze znacznikiem czasu. śledzenia punkt końcowy,
strefa, istniejąca, wartości metadanych źródłowych i suma kontrolna SHA-256.
4. Prześledź całość środowiska wykonawczego od metadanych, aż do uruchomienia
skrypt, wygenerowane manifesty Minecrafta i agenta deficytowego. Nagrywać
wartość jest miarajna podczas rozruchu i podczas `content-sync`.
5. Uzyskaj blokadę badania obejmującą punkt końcowy i przechwyć Compute Engine
odcisk palca metadanych przed odczytaniem wartości źródławej. Odmów badania, jeśli
akcja wirtualna lub akcja zawartość jest aktywna.

### Brama decyzyjna

- Automatyczna migracja tylko starszych zastrzeżeń i wyjątkowych okoliczności.
- W przypadku nie jednoznacznym wyświetleń starą treść w panelu administracyjnym jako
`migration pending` wymaga od administratora wybrania miejsca docelowego
serwer. Nigdy nie jest dostępny wyłącznie na działającym serwerze.

### Testy i akceptacja

1. Testy urządzeń obejmują wszystkie cztery klasyfikacje.
2. Inwentarz produkcyjny przeznaczony tylko do odczytu odpowiedzi na urządzenia przed a
zapis jest dostępny.
3. Test przywracania potwierdzenia, że ​​kopia zapasowa może dokładnie odtworzyć oryginalne metadane.

## Faza 1: Migracja zawartości wersjonowanej na serwer

### Wdrożenie

1. Dodaj wersję schematu i znacznika wyszukiwania do `vm-minecraft-servers`.
2. Dodaj idempotentną funkcję konfiguracji zaplecza:
- normalizacja starszej treści z określonymi walidacji
- skopiuj go, nigdy nie przenoś, nie udostępniaj wpisu serwera
- obserwacja przechwyconego odcisku palców metadanych do porównania i ustawień; załaduj ponownie i
     retry only when the source state is still equivalent
- zachowaj starsze metadane do czasu sprawdzenia po potwierdzeniu
- zapisz rekord audytu ze źródłem sumą kontrolną, identyfikatorem serwera docelowego i
     migration timestamp
3. Dodaj ekran poświęcony tylko dla administratora dla niejednoznacznych przypisań i
ustawienie dla każdego punktu końcowego.
4. Usuń starsze metadane tylko poprzez jawną akcję oczyszczającą po
wartość rejestru, używana na żywo i interfejs użytkownika są zgodne.

### Testy i akceptacja

1. Testy jednostkowe: puste, zniekształcone, zduplikowane, starsze singletony, występujące,
przypadki niejednoznaczne i powtórzone/idempotencji.
2. Testy współbieżności symulują podłączenie lub wyłączenie urządzenia wirtualnego pomiędzy
migracja odczytu i zapisu; migracja musi zostać ponowiona bezpiecznie, w razie wypadku niepowodzenia
utrata którejkolwiek aktualizacji.
3. E2E: zainstaluj inny dodatek testowy na dwóch oryginalnych usługach jednorazowych, odśwież oba
silny i sprawdź, czy każdego z nich widać tylko własną treść.
4. E2E: usuń jeden dodatek i sprawdź, czy drugi serwer pozostaje niezmieniony.
5. Przywróć: przywróć przechwyconą kopię zapasową metadanych i potwierdź stary stan interfejsu użytkownika
pozostanie odzyskany.

## Faza 2: Dokładna kompatybilność artefaktów Modrintha

### Wdrożenie

1. Zachowaj uwagę ogólnych aspektów wyszukiwania, aby sprawdzić responsywność:
- rodzaj projektu
- Wersja Minecrafta
- kategorie programów ładujących środowisko wykonawcze
2. Dla każdego wyszukiwania trafienia zapytaj punkt końcowy Modrinth, podając znaczenie
Dostęp do gry i lista programów ładujących przed wyświetleniem, jako możliwe do zainstalowania.
Odrzuć artefakty tylko u klienta i wybierz jeden plik do pobrania po stronie serwera
plik z opublikowaną sumą kontrolną.
3. Sprawdzanie zgodności pamięci podręcznej przez `(projectId, gameVersion, loaders)` dla a
krótki TTL, na przykład 10 minut. Powiązane współbieżne rozwiązania, aby uniknąć a
szukaj wyłącznika interfejsu API, zewnętrznego terminów wyszukiwania i urządzeń a
wyłącznik automatyczny po ograniczeniu kontrolnym Modrinth lub przełącznik.
4. Renderuj tylko kandydatów z co jednym z nich jest artefaktem. Jeśli sprawdziłeś katalog
upłynie limit czasu, zaznacz tego kandydata `verification unavailable` i wyłącz go
przycisk instalacji, zamiast prezentować go jako oprogramowanie. Zgłoszenie zweryfikowane
częściowe wyniki i miejsca pracy pominiętych kandydatów.
5. Zachowaj zabezpieczenie po stronie serwera podczas instalacji jako obowiązkowej
miejsce punkt autoryzacji. Przekaż ujawnioną tożsamość pliku i sumę kontrolną do
agenta wirtualnej maszyny, który przed aktywacją musi zweryfikować pobrany plik.

### Testy i akceptacja

1. Próbne odpowiedzi Modrintha dla dostosowanych tylko kategorii, bez dokładnego artefaktu;
nie można zainstalować.
2. Papier testowy, tkanina, kuźnia, NeoForge, starsze/domyślne, tylko dla klienta i
wieloplikowe urządzenia na stronie serwera.
3. E2E na sprawdzenie: wyszukaj, zainstaluj, sprawdź wynik agenta i plik
metadane, usuń, a następnie zweryfikuj listę poszczególnych serwerów.
4. Testy uwzględniono: Modrinth 429, przekroczenie limitu czasu, uwzględnienie JSON i brak kompatybilności
artefakt; nie może zostać przesłane mutacja metadanych ani kontenera.

## Faza 3: Czas działania CI i tajna higiena

### Analiza i projektowanie

1. Zidentyfikuj wydanie, przypięte do zatwierdzenia wersji każdego GitHuba
Akcja publikoca na Node.js 24. Potwierdź wcześniej otrzymanie informacji o wydaniu
aktualizowanie każdego SHA.
2. router, czy `USER_PASSWORD`, `NEKO_PASSWORD` i
`NEKO_PASSWORD_ADMIN` są wymagane jako urządzenia sterujące lub tylko wykonawcze
wartości podsumowujące. Śledź pliki tworzenia plików, punkty wejścia, szablony wdrożeń Cloud Run,
i skrypty startowe wirtualnej maszyny przed ich zmianą.
3. Zdefiniuj zachowanie środowiska uruchomieniowego w przypadku braku haseł:
- odrzucić niepewną konfigurację produkcyjną, lub
- wygeneruj go podczas przechowywania i przechowywania w Secret Managerze.
Ostateczny wybór musi być podłączony do prądu administratora.
4. Zdefiniuj niepublikowaną kontrolę sprawdzania poprawności plików Dockerfile i aktualizacja akcji:
wprowadzenie ściągnięcia, wejście `workflow_dispatch` lub niezmienny znacznika obrazu testowego.
Musi być rozszerzona bez aktualizacji `latest` lub istniejących tagów.

### Wdrożenie

1. Aktualizuj pojedyncze akcje, aby sprawdzić i przypiąć kompatybilność z Node.js 24
rewizja. Dodaj Zależnego robota lub głównego przepływomierza pracy na końcu
zabawa.
2. Zaawansowany zestaw ustawień poświadczeń osadzonych w konfiguracji szczękowej
instalacja wodociągowa. Przekazuj wartości rzeczywiste podczas tylko stosowania/w czasie wykonywania z ujawnienia tajnego
źródła.
- Najpierw klasyfikuj każdą wartość jako symbol zastępczy, wartość domyślną programistyczną lub
     production credential
- przechowywanie zachowane symboli zastępczych tylko wtedy, gdy środowisko wykonawcze jest odrzuci
     externally reachable deployments
3. Dodaj kontrolę zasad CI, która kończy się niepowodzeniem po dodaniu wartości przypominającej hasło do pliku
Plik Dockerfile `ARG` lub `ENV`, z ujawnionych, nietajnych symboli zastępczych.

### Testy i akceptacja

1. Zbuduj obrazy Debiana i Archa w ścieżce walidacyjnej niepublikowanej,
następnie powtórz na ścieżce publikacji i zweryfikuj publikację obrazu.
2. Uruchomiony każdy z dostępnymi kluczami produkcyjnymi i sprawdź
oczekiwany interfejs sieciowy i ścieżki uwierzytelniania Sunshine.
3. podlega, że ​​inspekcja obrazu i dzienniki aplikacyjne nie obejmuje rzeczywistych wartości poświadczeń.
4. nastąpi, że GitHub Actions nie wyświetli już wystąpienia o wycofaniu Node.js 20.

## Faza 4: Lokalne środowisko programistyczne Docker/WSL

### Analiza

1. Wykryj, czy jest integracją z Docker Desktop, czy natywnym demonem Docker WSL
zamierzony silnik lokalny.
2. Zapisz `docker context ls`, `docker version`, gniazdo gniazda, WSL
interop i stan usług systemowych bez sterowania uruchamianiem czegokolwiek.
3. Podaj instrukcję dotyczącą naprawy z Docker Desktop
i natywny `docker.service`; nie włączaj obu jednocześnie.

### Testy i akceptacja

1. `docker version` raportuje zarówno klienta, jak i serwer z WSL.
2. `docker buildx build --check -f Dockerfile.arch .` powiedzie się lokalnie.
3. Kompilacja Arch bez publikowania kończy się umiejętnością z tymi samymi argumentami, których używają
   CI.

## Zamówienie przesłania

1. Faza 0, następnie faza 1 jako wydanie niezależne.
2. Faza 2 po zapoznaniu się z treścią, po jej badaniu E2E od sprawdzenia wiarygodności
stan na serwerze.
3. Faza 3 w izolowanych zatwierdzeniach CI/dozwolonych; brak zmian w zachowaniu kontroli wirtualnej maszyny
do samodzielnego wydania.
4. Faza 4 jest pracą operacyjną i nie blokuje produkcji
zastosowanie.

## Kryteria zakończenia

Naprawa jest tylko wtedy, gdy:

1. Każdy serwer na żywo ma zweryfikowany stan zawartości treści lub jawny
decyzja o badaniu administratora.
2. Interfejs użytkownika nigdy nie przedstawia wyników Modrinth, których nie można zastosować, jako narzędzie do zainstalowania.
3. Obie wersje są wymagane i bez zastosowania dotyczące Node.js 20, a wersja
pozostałe zasady poświadczeń pliku Dockerfile są albo wolne od ostrzeżeń, albo jawne
Substancja dopuszczalna zastępcza, która nie zawiera produkcji
sekret.
4. Programista może odtworzyć walidację Arch lokalnie, z podaniem wersji
Konfiguracja Dockera/WSL.
