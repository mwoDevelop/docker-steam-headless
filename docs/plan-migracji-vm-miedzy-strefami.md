# Plan: migracja zapisanej VM miedzy strefami

## Cel

Dodac do panelu administratora mozliwosc przygotowania kopii zatrzymanej VM w
innej strefie, z zachowaniem jej profilu CPU/GPU i danych. Funkcja ma obslugiwac
dwa warianty:

- **Kopiuj** - zachowuje zrodlowa VM oraz przygotowuje niezalezny cel.
- **Przenies** - po bezpiecznym przygotowaniu celu usuwa zrodlowa VM i jej dysk
  stanu, pozostawiajac czasowy punkt odzyskiwania.

Migracja nie uruchamia VM i nie rezerwuje ani nie sprawdza biezacej pojemnosci
GPU. GPU jest weryfikowane przez Google Compute Engine dopiero przy pozniejszej
akcji `Start` przygotowanego celu.

## Uzasadnienie modelu

Dysk persistent jest zasobem strefowym, dlatego nie mozna go po prostu podlaczyc
w innej strefie. Snapshot mozna natomiast odtworzyc jako nowy dysk w strefie
docelowej.

Nie nalezy tworzyc podczas migracji rzeczywistej instancji GPU w stanie
`TERMINATED`: utworzenie takiej instancji moze juz wymagac alokacji GPU. Zamiast
tego system bedzie tworzyl **przygotowany cel migracji** (`staged VM`): profil
VM, snapshot i docelowy dysk stanu. Taka pozycja nie jest jeszcze instancja GCE
i musi byc tak oznaczona w GUI.

## Wynik niezaleznego review planu

Review wykryl nastepujace ryzyka i wprowadza ponizsze doprecyzowania:

1. **Kompletnosc danych.** Nie wolno zakladac, ze wszystkie dane uzytkownika sa
   na dysku stanu. Przed implementacja nalezy zinwentaryzowac dane trwale na
   boot disk i state disk: Steam, Flatpak, Minecraft, Sunshine, dane aplikacji,
   runtime images i lokalne konfiguracje. Dla kazdej kategorii trzeba albo
   potwierdzic odtwarzanie przez bootstrap, albo objac ja migracja.
2. **Semantyka `Move`.** Przygotowany cel nie jest dzialajaca VM, dlatego
   usuniecie zrodla nastepuje dopiero po sukcesie przygotowania. Snapshot jest
   zasobem tymczasowym: po odtworzeniu docelowego dysku jest usuwany, podobnie
   jak po bledzie migracji. Nieudany `Start` zachowuje przygotowany dysk, ale
   nie pozostawia snapshotu.
3. **Tozsamosc i endpoint.** Identyfikator logiczny VM, nazwa instancji GCE,
   DNS DuckDNS i publiczny IP sa oddzielnymi rzeczami. `Move` zachowuje logiczna
   tozsamosc i moze odziedziczyc endpoint; `Copy` tworzy nowa logiczna VM oraz
   wymaga nowego, wolnego endpointu. DNS jest aktualizowany dopiero po zdrowym
   starcie nowej instancji.
4. **Zakres.** Pierwsza wersja obsluguje wylacznie migracje miedzy strefami w
   tym samym projekcie GCP. Migracja miedzy projektami, kontami rozliczeniowymi
   i regionami wymaga osobnego projektu, uprawnien IAM oraz analizy kosztow.
5. **Quota i idempotencja.** Pomijanie sondy GPU nie oznacza pomijania quota
   snapshotow i dyskow. Kazdy etap ma miec stabilny `operationId`, etykiety GCE
   i zapisana odpowiedz, aby retry po timeout nie tworzyl drugiego dysku ani
   drugiego snapshotu.
6. **Wspolbieznosc.** Blokada ma obejmowac zrodlo, docelowy endpoint i zestaw
   `hardware + zone`; inaczej rownolegle klikniecia moglyby utworzyc kolidujace
   zasoby.

## Warunek wstepny: inwentaryzacja danych

Przed implementacja backendu nalezy ustalic, ktore dane sa trwale przechowywane
na boot disk, a ktore na state disk. Wynik nalezy zapisac w dokumentacji i
przeksztalcic w kontrakt migracji:

- dane na state disk sa kopiowane przez snapshot i odtworzenie dysku,
- dane generowane przez bootstrap sa odtwarzane z zapisanego manifestu wersji,
- dane na boot disk, ktorych bootstrap nie odtwarza, wymagaja dodatkowego
  snapshotu boot disk albo przeniesienia na state disk.

Manifest przygotowanego celu musi utrwalac dokladne wersje runtime images oraz
konfiguracji zrodlowej VM. Nie moze niejawnie zamieniac ich na `LATEST`, bo
migracja ma odtwarzac stan zrodla, a nie wykonywac aktualizacje.

## Zakres i reguly

1. Migracja jest dostepna wylacznie dla VM w stanie `TERMINATED`.
2. Zrodlo musi nie miec aktywnej akcji asynchronicznej: create, start, stop,
   restart, delete, backup, restore, instalacji oprogramowania ani aktualizacji
   obrazu runtime.
3. Zmienna jest tylko strefa; profil sprzetowy, konfiguracja i dane stanu sa
   kopiowane ze zrodla.
4. Docelowa strefa musi statycznie obslugiwac profil CPU/GPU, ale funkcja nie
   wykonuje sondy pojemnosci ani krotkotrwalej rezerwacji GPU.
5. Docelowa strefa musi byc inna niz zrodlowa.
6. Jednoczesnie uruchomiona pozostaje maksymalnie jedna VM. Ograniczenie
   obowiazuje przy `Start`, nie przy przygotowywaniu migracji.
7. Wpis `Prepared` lub `Staged` nie jest prezentowany jako `TERMINATED VM`, bo
   nie istnieje jeszcze jako instancja Compute Engine.

## Model danych

Dodac trwaly rekord celu migracji, np. `vm_migration_targets`, zawierajacy:

- identyfikator zrodla i docelowy identyfikator logicznej VM,
- oddzielne pola dla identyfikatora logicznego VM, nazwy instancji GCE, DNS i
  publicznego IP,
- tryb `copy` albo `move`,
- profil hardware (`hardwareId`, typ maszyny, GPU i liczba GPU),
- strefe zrodlowa i docelowa,
- snapshot migracyjny oraz identyfikator odtworzonego dysku stanu,
- wybrany DNS/endpoint i jego stan przypisania,
- stan procesu: `preparing`, `prepared`, `failed`, `starting`, `started`,
  `cleanup_pending`, `cleaned`,
- szczegoly bledu, znaczniki czasu i dane rozliczeniowe dysku/snapshotu,
- flage okresu odzyskiwania dla wariantu `move`.

Rekord musi byc jednoznacznie skojarzony z `hardware + target zone + endpoint`,
aby usuniete lub ponownie utworzone VM nie pozostawialy blednych przypisan.

## Przeplyw backendu

### Przygotowanie migracji

1. Zweryfikowac autoryzacje administratora, stan `TERMINATED`, brak aktywnej
   akcji, zgodnosc profilu z docelowa strefa oraz quota dyskow i snapshotow.
2. Zablokowac rownolegla migracje tego samego zrodla, docelowego endpointu oraz
   tego samego zestawu `hardware + zone`.
3. Utworzyc snapshot zrodlowego dysku stanu z etykietami migracji.
4. Odtworzyc nowy dysk stanu w docelowej strefie ze snapshotu.
5. Zapisac rekord `prepared` wraz z profilem zrodlowej VM i docelowym dyskiem.
6. W wariancie `copy` pozostawic zrodlo bez zmian.
7. Usunac tymczasowy snapshot po poprawnym odtworzeniu docelowego dysku; w
   wariancie `move` dopiero nastepnie usunac zrodlo.

W razie bledu zrodlo pozostaje nienaruszone, a backend usuwa tymczasowy
snapshot. Nieudane czyszczenie jest zapisywane jako `cleanup_pending`, dajac
administratorowi mozliwosc bezpiecznego ponowienia.
Kazdy etap zapisuje `operationId`, etykiety zasobow i odpowiedz GCE, aby retry
po timeout nie duplikowal zasobow.

### Start przygotowanego celu

1. Sprawdzic globalne ograniczenie jednej uruchomionej VM.
2. Utworzyc instancje Compute Engine z zapisanym profilem i istniejacym
   docelowym dyskiem stanu, bez tworzenia nowego pustego dysku.
3. Dopiero tutaj obsluzyc ewentualny blad pojemnosci GPU z GCE.
4. Po udanym uruchomieniu przeprowadzic zwykla inicjalizacje, health checki
   Sunshine/Minecraft i aktualizacje endpointu/DuckDNS.
5. Po pierwszym potwierdzonym zdrowym starcie oznaczyc migracje jako `started`;
   snapshot nie jest juz obecny, bo zostal usuniety po przygotowaniu dysku.

## DNS i endpointy

- `Move` moze zachowac endpoint zrodlowej VM, ale DNS nie moze zostac
  przelaczony przed udanym startem celu.
- `Copy` wymaga wolnego endpointu, np. `mwo-vm2` lub `mwo-vm3`; brak wolnego
  endpointu blokuje przygotowanie z czytelnym komunikatem.
- Rekord przygotowanej VM rezerwuje wybrany endpoint logicznie, ale nie
  przypisuje publicznego IP ani nie aktualizuje DuckDNS.
- Usuniecie przygotowanego celu zwalnia endpoint i usuwa jego dysk oraz snapshot
  zgodnie z wybrana opcja czyszczenia.

Do czasu zdrowego startu DNS ma wskazywac ostatnia zdrowa instancje albo nie byc
przypisany. Nie moze wskazywac na efemeryczny IP ani na przygotowany, lecz
nieistniejacy serwer.

## GUI

1. Dodac w panelu administratora zakladke lub sekcje **Migracje VM** obok
   funkcji zarzadzania VM, a nie do zwyklego widoku tylko do odczytu.
2. Dla zatrzymanej VM pokazac akcje `Kopiuj do strefy` i `Przenies do strefy`.
3. Formularz ma zawierac docelowa strefe, wariant operacji, docelowy endpoint
   (obowiazkowy dla kopii) oraz podsumowanie przewidywanych kosztow snapshotu i
   dysku.
4. Lista przygotowanych celow pokazuje profil, strefe, endpoint, status,
   snapshot, dysk, koszt i akcje: `Start`, `Usun przygotowany cel`,
   `Pokaz szczegoly`.
5. Komunikaty bledow z GCE i postep operacji wyswietlac w standardowym miejscu
   aktywnosci, bez duplikowania alertow.
6. Po zakonczeniu kazdej akcji odswiezac lokalny model GUI, selektory VM i
   endpointow bez wymuszania odswiezenia strony.

## Bezpieczenstwo i sprzatanie

- Wszystkie akcje migracji ograniczyc do administratorow.
- Nie ujawniac sekretow ani hasla Sunshine w metadanych migracji.
- Dla `move` wymagac jednoznacznego potwierdzenia usuniecia zrodla.
- Usuwac snapshoty automatycznie po udanym przygotowaniu i po bledzie; pokazac
  ich aktualna liczbe przy przycisku przygotowania oraz status `cleanup_pending`
  po czesciowym bledzie.
- Nigdy nie usuwac zasobu bez sprawdzenia etykiet oraz identyfikatora migracji;
  chroni to niezalezne dyski i snapshoty uzytkownika.

## Testy akceptacyjne

1. Odrzucenie migracji dla `RUNNING` i przy aktywnej akcji.
2. Kopia CPU do innej strefy: zrodlo pozostaje, cel jest `prepared`, nie ma
   uruchomionej instancji ani rezerwacji GPU.
3. Przeniesienie CPU: cel jest przygotowany, zrodlo usuniete dopiero po sukcesie
   docelowego dysku, a tymczasowy snapshot nie pozostaje w projekcie.
4. Kopia GPU do zgodnej strefy bez pojemnosci: przygotowanie ma sie udac bez
   sondy/rezerwacji GPU; `Start` ma pokazac prawdziwy blad pojemnosci GCE.
5. Start przygotowanego celu po odzyskaniu pojemnosci GPU: dysk stanu jest
   podlaczony, Sunshine i dane aplikacji dzialaja, a DNS zostaje przelaczony
   dopiero po health checku.
6. Brak wolnego endpointu dla `copy` oraz kolizja endpointu: czytelny blad bez
   utworzenia zasobow.
7. Awaria snapshotu, odtworzenia dysku i czesciowego czyszczenia: zrodlo nie
   jest usuniete, a zasoby tymczasowe sa raportowane i daja sie bezpiecznie
   usunac ponownie.
8. Regresja: backup, restore, create, start, stop, delete i automatyczne
   zwalnianie efemerycznych IP zachowuja obecne dzialanie.
9. Test integralnosci: po migracji sprawdzic Steam, konfiguracje Sunshine,
   Minecraft, zainstalowane rozszerzenia i dane aplikacji wobec inwentaryzacji
   dyskow; nie wystarcza sam poprawny start instancji.
10. Test ponowienia: zasymulowac timeout po utworzeniu snapshotu oraz po
    odtworzeniu dysku i potwierdzic brak zduplikowanych zasobow.

## Kolejnosc realizacji

1. Zinwentaryzowac dane boot/state oraz zapisac kontrakt odtworzenia danych.
2. Dodac model danych, walidacje i API statusu bez zmiany obecnego przeplywu
   create/start.
3. Zaimplementowac snapshot, odtworzenie dysku oraz idempotentne sprzatanie.
4. Zaimplementowac obsluge `copy`, potem `move` z potwierdzeniem i automatycznym
   usuwaniem snapshotow.
5. Rozszerzyc `Start` o materializacje przygotowanego celu.
6. Dodac GUI administratora, odswiezanie stanu i komunikaty postepu.
7. Przeprowadzic testy jednostkowe, integracyjne i E2E dla scenariuszy powyzej.
8. Wdrozyc najpierw na jednym celu CPU, a dopiero potem wykonac test GPU w
   dostepnej strefie.
