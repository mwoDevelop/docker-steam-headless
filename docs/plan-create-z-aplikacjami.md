# Plan: tworzenie VM z opcjonalna instalacja aplikacji

## Cel

Podczas akcji `Create` na glownym GUI pokazac modal z lista dostepnych aplikacji
desktopowych. Uzytkownik moze zaznaczyc dowolny podzbior albo nie zaznaczyc
niczego. Po utworzeniu VM wybrane aplikacje maja zostac zainstalowane
automatycznie, a GUI ma pokazywac rzeczywisty postep oraz wynik kazdej z nich.

Poczatkowy katalog obejmuje: `Steam`, `PrismLauncher` i `Google Chrome`.
Lista nie moze byc zahardkodowana drugi raz w GUI - ma pochodzic z tego samego
katalogu backendu, ktory obsluguje instalacje w panelu `Software`.

## Granice

- Funkcja dotyczy tylko nowo tworzonej VM przez `Create`.
- Brak zaznaczonych aplikacji zachowuje obecne zachowanie tworzenia VM.
- Funkcja nie przekazuje hasel, tokenow ani sesji aplikacji. Konfiguracja
  po instalacji i temat credentiali pozostaja osobnym zadaniem.
- `Start`, `Restart`, `Restore Backup`, migracja oraz reczna instalacja w
  panelu administratora nie zmieniaja semantyki.

## Projekt rozwiazania

### 1. Kontrakt API i walidacja

1. Rozszerzyc zadanie `create` o opcjonalne pole `applicationIds`, bedace
   lista unikalnych identyfikatorow z `APPLICATION_CATALOG`.
2. Backend odrzuca nie-tablice, duplikaty, puste wartosci i identyfikatory
   spoza katalogu przed wykonaniem jakiejkolwiek operacji GCE.
3. Do odpowiedzi konfiguracji dostarczanej glownemu GUI dodac bezpieczny
   katalog aplikacji: `id`, `label`, `description`. Nie dodawac danych
   instalacyjnych ani zadnych przyszlych credentiali.
4. Zachowac ten sam wymog autoryzacji, ktory obowiazuje dla `Create`; lista
   aplikacji nie daje dodatkowych uprawnien.

### 2. Modal w glownym GUI

1. Zastapic bezposrednie wyslanie `Create` modalem HTML `dialog`, otwieranym
   tylko gdy wybrany profil i strefa umozliwiaja utworzenie VM.
2. Modal pokazuje nieedytowalne podsumowanie endpointu, hardware, strefy oraz
   kazda aplikacje jako checkbox z nazwa i opisem. Domyslnie wszystkie pola sa
   odznaczone.
3. Udostepnic trzy jednoznaczne drogi:
   - `Create without applications` wysyla pusta liste.
   - `Create and install selected` wysyla wybrane identyfikatory i jest
     aktywny tylko przy co najmniej jednym wyborze.
   - `Cancel` i klawisz Escape nie wysylaja zadania.
4. Zadbac o obsluge klawiatury, fokus po otwarciu i zamknieciu, czytelne
   etykiety oraz uklad mobilny. Modal jest blokowany przez aktywny globalny
   loader, tak jak pozostale akcje.

### 3. Trwale wykonanie po utworzeniu VM

1. W czasie `Create` zapisac zatwierdzona liste oraz identyfikator akcji w
   trwalym stanie zadania powiazanym z VM, a nie tylko w pamieci procesu
   Cloud Run. Nalezy wykorzystac obecny mechanizm trwałego statusu akcji VM
   lub metadane GCE, nie stan instancji Cloud Run.
2. Po utworzeniu VM i osiagnieciu aktualnego warunku gotowosci (dysk stanu,
   usluga, Sunshine) uruchamiac instalacje sekwencyjnie przez istniejacy agent
   `power-action.sh`.
3. Wprowadzic zadanie zbiorcze `bootstrap-applications`, ktore przechowuje
   `total`, `completed`, `currentApplication`, wynik kazdej aplikacji i blad.
   Agent ma wykorzystywac istniejace, idempotentne instalatory
   `install-app:steam`, `install-app:prism` oraz `install-app:chrome`.
4. Nie wykonywac instalacji rownolegle. Flatpak, konfiguracja Sunshine i
   restart Sunshine musza miec w danej VM tylko jedna akcje zapisujaca.
5. Dopiero terminalny wynik zadania zbiorczego konczy `Create` w GUI. Gdy
   lista jest pusta, nie dodawac etapu bootstrap i zachowac obecna sciezke.
6. Po restarcie Cloud Run, odswiezeniu strony albo chwilowym bledzie odczytu
   statusu backend odtwarza postep z trwalego stanu. Nie moze ponownie
   zainstalowac juz zakonczonej aplikacji.

### 4. Wynik i obsluga bledow

1. Loader `Create` ma prezentowac etapy: tworzenie VM, gotowosc uslug oraz
   `Installing selected applications (n/m): <nazwa>`.
2. Status API zwraca osobny blok post-create applications, aby glowne GUI,
   panel administratora i reczne `Status` wyswietlaly te same dane.
3. Awaria jednej aplikacji nie usuwa VM i nie maskuje sukcesu utworzenia.
   Kontynuowac kolejne wybrane instalacje, o ile agent pozostaje zdrowy.
4. Koncowy komunikat wskazuje pelny wynik, np. `VM created; 2/3 applications
   installed; Steam failed: <bezpieczny blad>`. Nie umieszczac w nim danych
   wrazliwych ani pelnych logow instalatora.
5. Nie usuwac listy zadan po bledzie: ma pozwolic na pozniejszy retry w
   panelu `Software`. Po pelnym sukcesie zachowac tylko krotkie, audytowalne
   podsumowanie.
6. Przy odtwarzaniu danych z backupu instalacje pozostaja idempotentne. Juz
   obecna aplikacja ma zostac potwierdzona jako gotowa, a nie instalowana drugi
   raz albo traktowana jako blad.

### 5. Integracja z administracja i aktywnoscia

1. `Software` nadal pozwala niezaleznie instalowac i odinstalowywac aplikacje.
   Powinien tez pokazywac, ze trwa automatyczna instalacja po `Create`, z
   aktywnymi akcjami zablokowanymi dla tej VM.
2. `Activity` zapisuje zanonimizowane zdarzenia: lista identyfikatorow
   aplikacji, rozpoczecie, wynik i blad. Nie zapisywac argumentow procesu,
   danych logowania ani tekstu z plikow konfiguracyjnych aplikacji.
3. Stan typu `bootstrapping applications` musi byc uznany za akcje w toku w
   calej aplikacji. Nie wolno w tym czasie umozliwiac sprzecznych akcji,
   takich jak `Delete`, `Restart`, `Backup` lub reczna instalacja dla tej samej
   VM, poza bezpiecznym odswiezeniem `Status`.

## Pliki przewidziane do zmiany

- `cloud-run-vm-control/app.py`: schema polecenia, katalog w konfiguracji,
  trwale zadanie bootstrap, status, autoryzacja i komunikaty bledow.
- `gcp-vm/power-action.sh`: sekwencyjne wykonanie i raportowanie zadania
  `bootstrap-applications`, ponowienia idempotentne oraz jednoznaczne fazy.
- `docs/vm-control/admin.html`: semantyczny modal `Create` w osadzonym panelu
  `VM Control`. Publiczne `index.html` pozostaje widokiem tylko do odczytu.
- `docs/vm-control/app.js`: stan modalu, budowanie checkboxow, wyslanie
  `applicationIds`, odczyt i wizualizacja postepu.
- `docs/vm-control/styles.css`: dostepny, responsywny wyglad modalu i etapu
  instalacji.
- `docs/vm-control/admin.js`: blokada kolidujacych akcji oraz status
  automatycznej instalacji w zakladce `Software`.
- Testy backendu i E2E oraz dokumentacja uzytkownika, jezeli ich obecny
  zakres obejmuje tworzenie VM i katalog aplikacji.

## Plan testow

1. Testy backendu: pusta lista, poprawna lista, wszystkie aplikacje,
   duplikaty, nieznany identyfikator, brak uprawnien i odtworzenie zadania po
   ponownym odczycie statusu.
2. Testy agenta: kazda aplikacja osobno, lista wielu aplikacji, juz
   zainstalowana aplikacja, blad pojedynczej aplikacji, kontynuacja kolejnych
   i brak rownoleglych akcji.
3. Test E2E w przegladarce CDP: modal otwiera sie dla `Create`, zamkniecie nie
   tworzy VM, pusta lista zachowuje stare zachowanie, a wybrane aplikacje
   pojawiaja sie w Sunshine oraz w panelu `Software`.
4. Test E2E na taniej, jednorazowej VM CPU: utworzenie z Chrome i Prism,
   kontrola postepu bez odswiezenia strony, `Status` w trakcie instalacji,
   odswiezenie strony, a nastepnie deinstalacja i `Delete` testowej VM.
5. Osobny test Steam, poniewaz pobiera wiekszy runtime Flatpak: potwierdzic
   pakiet `com.valvesoftware.Steam`, launcher Sunshine, poprawna deinstalacje
   i brak pozostawionego launchera.
6. Regresja: `Create` bez aplikacji, `Start`, `Stop`, `Restart`, `Delete`,
   `Backup`, `Restore Backup`, auto-stop, reczna instalacja z `Software` oraz
   odswiezenie endpointow po usunieciu VM.
7. Po testach usunac wszystkie testowe VM, dyski, efemeryczne IP i tymczasowe
   statusy zadan; potwierdzic brak kosztujacych zasobow.

## Kryteria akceptacji

- Modal pozwala uruchomic `Create` z zerem, jedna lub wieloma aplikacjami.
- Wybrane aplikacje sa instalowane automatycznie dopiero po gotowosci VM.
- Postep i wynik sa spojne w loaderze, `Status`, glownym GUI oraz `Software`.
- Blad aplikacji nie ukrywa stanu VM ani nie powoduje utraty pozostalych
  wynikow.
- Zmiana nie przechowuje ani nie wyswietla credentiali aplikacji.
- Wszystkie testowe zasoby GCP zostaja po E2E usuniete.

## Niezalezny review planu i przyjete korekty

### Znalezione luki

1. Plan zakladal trwale zadanie, ale nie rozdzielal wyraznie zapisu intencji
   `Create` od wykonania instalacji. Cloud Run jest bezstanowy, wiec sam
   proces HTTP nie moze byc zrodlem prawdy.
2. Blokada `Delete` w trakcie bootstrapu uniemozliwialaby ograniczenie
   kosztow po bledzie duzego pobierania Flatpak albo utracie potrzeby VM.
3. Dlugie instalacje nie moga wydluzac odpowiedzi `Create` do granicy timeoutu
   Cloud Run ani powodowac ponownego uruchomienia instalacji po retry HTTP.
4. Czesc instalatorow jest idempotentna tylko praktycznie. Brakuje jawnego
   kontraktu: ponowienie po odzyskaniu stanu ma rozpoznac aplikacje gotowa,
   a nie tworzyc duplikat launchera Sunshine.
5. Plan nie okreslal, co dzieje sie przed utworzeniem VM, przy bledzie GCE
   oraz przy odtworzeniu danych, ktore juz zawieraja aplikacje.

### Przyjete poprawki

1. Utworzyc jedno, trwale zadanie `post-create-applications` zapisane z
   metadanymi VM przed przekazaniem kontroli do asynchronicznego lifecycle.
   Ma ono identyfikator, liste aplikacji, indeks, wyniki per aplikacja i
   terminalny stan. Wszystkie odczyty statusu odtwarzaja ten rekord.
2. `Create` przyjmuje zlecenie i pokazuje postep asynchronicznie; backend nie
   czeka synchronicznie na pobrania Flatpak. Bez aplikacji zachowuje obecny
   czas i odpowiedz `Create`.
3. `Delete` pozostaje dostepne jako jawna akcja przerwania: przed usunieciem
   VM uniewaznia oczekujace zadanie bootstrapu. `Restart`, `Backup`,
   `Restore Backup` i reczne zmiany aplikacji pozostaja zablokowane do
   terminalnego wyniku zadania.
4. Agent przed kazda instalacja sprawdza faktyczny pakiet i wpis Sunshine.
   Brakujacy tylko jeden z artefaktow naprawia bez duplikowania wpisu;
   kompletna instalacja jest wynikiem `already_installed`.
5. Przy bledzie GCE zadanie bootstrapu przechodzi w `cancelled` bez wywolania
   agenta. Po odtworzeniu danych z backupu instalatory wykonuja ten sam
   idempotentny test przed instalacja.
6. W statusie rozdzielic `VM action` od `post-create applications`, aby
   utworzona i dzialajaca VM nie byla przedstawiana jako nieudane `Create`
   tylko dlatego, ze pojedyncza aplikacja nie zostala zainstalowana.
