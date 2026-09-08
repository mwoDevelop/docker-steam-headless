# Plan: aktualny i kompletny katalog obrazow runtime

## Cel i zakres

Pola Target w Runtime images maja pokazywac wszystkie obslugiwane obrazy
Linux/amd64 z zaufanych repozytoriow, w tym aktualne aliasy latest/stable.
Nie oznacza to automatycznej aktualizacji dzialajacych VM ani dopuszczenia
niezgodnych obrazow Arch Linux lub dowolnych repozytoriow.

Diagnoza 2026-09-08: GUI uzywa katalogu z 2026-07-27. Backend nie ma TTL,
czyta tylko pierwszych 100 tagow, obcina wynik do 24 wpisow, usuwa aliasy
tego samego digestu. GUI nie pokazuje bledu odswiezania starego katalogu.

## Zmiany

1. Backend, cloud-run-vm-control/app.py: paginacja calego katalogu Docker Hub,
   bez arbitralnego limitu 24 opcji. Stale repozytoria i linux/amd64 pozostaja
   granica zaufania. Limit czasu, liczby stron i walidacja paginacji chronia
   przed nieskonczona petla; niekompletne pobranie nie zastepuje starej listy.
2. Rozszerzyc zgodne aliasy: Steam Headless latest/debian oraz wersjonowane
   debian; Minecraft stable-java17/21/25 i dotychczasowe warianty. Zachowac
   dotychczasowy tag developerski, oznaczajac jego charakter. Pokazac w GUI
   jawnie zakres kompatybilnosci i liczby tagow pomijanych przez filtr.
3. Zachowac aliasy obrazow o tym samym digescie: jedna opcja obrazu z lista
   aliasow, np. latest / debian. Wybor nadal przekazuje niezmienny digest,
   a nie ruchomy tag. Aktualny digest VM nie moze zostac po cichu podmieniony.
4. Wprowadzic wersje schematu katalogu i TTL (domyslnie 6 h), wymuszone
   odswiezenie reczne, blokade wspolbieznego odswiezania w procesie oraz
   backoff po bledzie. Migracja starego cache ma zachowac jego dane do czasu
   udanego pobrania. Brak sieci nie moze blokowac calego panelu.
5. Publikowac katalog atomowo dopiero po udanym pobraniu obu komponentow
   i zapisie w Secret Manager. Nie tworzyc nowych wersji sekretu przy kazdym
   GET. Jawny status aktualnosci, data proby, ostrzezenie i blad pozostaja
   widoczne przy fallbacku; nie wyswietlac falszywego komunikatu sukcesu.
6. Frontend, docs/vm-control/admin.js: etykiety aliasow, daty, liczby wersji,
   zakres filtra, linki do repozytoriow i komunikaty fallbacku. Zachowac
   wybrany Target przy ponownym renderowaniu dla tej samej VM, jezeli digest
   nadal wystepuje. Nie przenosic wyboru miedzy roznymi VM.

## Testy i rollout

- Testy backendu: wiele stron, tag na dalszej stronie, >24 wyniki, aliasy,
  wybor amd64, niewlasciwe repo/architektura, niepoprawne dane, petla i limit
  stron, timeout/429, blad zapisu sekretu, brak TTL refresh dla swiezego cache,
  odswiezenie starego schematu i cache, reczna proba po bledzie, backoff.
- Testy frontendu: render aliasow i ostrzezen, zachowanie wyboru, brak
  komunikatu sukcesu po bledzie oraz brak zmian na VM podczas refresh.
- Niezalezny review planu przed implementacja; uwzglednic zasadne uwagi.
- Pelne istniejace testy backendu, kontrole skladni JS/Python.
- Commit/push, deploy backendu i GitHub Pages. E2E przez CDP 9222:
  automatyczna aktualizacja starej listy, reczny refresh, porownanie obu list
  z Docker Hub, symulowany blad odpowiedzi w przegladarce, przelaczanie VM.
- Nie restartowac ani aktualizowac obrazow na VM w ramach testu katalogu.
  Ewentualne bledy poprawic, wdrozyc ponownie i powtorzyc testy.

## Status

Review wykonany przez niezaleznego agenta agy-yolo (gemini-3.8-flash-high).
Przystepujemy do implementacji z ponizszymi doprecyzowaniami.

## Decyzje po review

- GET nie odpytuje Docker Hub. Zwraca cache z informacja stale; GUI po
  zaladowaniu panelu uruchamia ograniczony czasowo refresh w tle (tylko lista
  runtime, bez blokowania pozostalych zakladek). Reczna proba omija backoff.
- Cache Secret Manager jest sprawdzany okresowo, nie tylko raz na proces.
  Odswiezenie automatyczne najpierw sprawdza, czy inny proces nie opublikowal
  juz aktualnego katalogu. Blokada lokalna nie udaje blokady rozproszonej.
- Zapis sekretu tylko przy zmianie danych katalogu/schematu, nie samego czasu
  kontroli. lastCheckedAt bez zmiany zawartosci pozostaje w pamieci procesu;
  zimny proces moze wykonac dodatkowa kontrole. To swiadomy kompromis kosztowy.
- Pole tag pozostaje stringiem dla zgodnosci API i agenta VM. Nowe aliases
  przechowuje liste nazw; stary cache migruje przez aliases=[tag].
- Zachowujemy pelna paginacje (obecnie Minecraft ma 1972 tagi, ok. 20 stron).
  Odrzucono sugestie ponownego obcinania wynikow. Bezpiecznik: maksymalnie
  100 stron i 60 sekund lacznie, jawny blad/fallback po przekroczeniu limitu.
- Steam: latest, debian, dotychczasowy jawny tag developerski, debian-X.Y.Z
  oraz debian-YYYYMMDD; bez luznego wzorca dopuszczajacego dowolne tagi dev.
  Minecraft: latest, stable, java17/21/25, stable-java17/21/25,
  YYYY.M.D-java17/21/25. Inne warianty sa jawnie poza zakresem zgodnosci.
- Testy obejma brak zapisu identycznej zawartosci, blad zapisu sekretu,
  render starego cache, zachowanie stringa tag, wybor per endpoint/komponent,
  odswiezanie w tle, brak downgradu nowej listy przez starsza odpowiedz GET.

## Korekta po tescie z Docker Hub

Docker Hub zwraca 403 od offsetu 1000 dla anonimowej paginacji (potwierdzone
na stronie 11 katalogu Minecraft). Dla repozytorium >1000 tagow pobieramy
wiec komplet wszystkich pasujacych tagow przez osobno stronicowane filtry
name=java17/java21/java25/latest/stable. Filtry lacznie pokrywaja cala regule
dopuszczania tagow Minecraft; duplikaty sa usuwane, aliasy zachowane.
To nie jest obciecie do pierwszych 1000 wpisow. Liczba wszystkich tagow
upstream pochodzi z pierwszej odpowiedzi. Nie sa potrzebne nowe credentiale.

Test E2E wykryl blokade przyciskow po zniknieciu wybranego Target z katalogu:
wybor nowego obrazu musi natychmiast przeliczyc dostepnosc akcji. Dodano tez
test, w ktorym udany reczny refresh usuwa blad klienta z dokladniejszym
znacznikiem czasu (milisekundy klienta vs sekundy backendu).
