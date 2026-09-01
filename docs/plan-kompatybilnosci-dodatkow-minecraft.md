# Plan stabilnej kompatybilności dodatków Minecraft

## Status dokumentu

- Status: plan do implementacji.
- Zakres: pluginy i mody instalowane z Modrinth dla wielu instancji serwera Minecraft na VM.
- Data aktualizacji: 2026-09-01.
- Dokument zastępuje szczegółowy zakres fazy 2 z
  [dalszego planu naprawy ryzyka](./follow-up-risk-remediation-plan.md).

## Cel

Celem jest bezpieczne instalowanie i usuwanie pluginów oraz modów bez
wprowadzania statycznych list dozwolonych projektów i bez blokowania poprawnych
dodatków tylko dlatego, że ich metadane są niepełne.

Rozwiązanie ma:

1. Odrzucać jednoznacznie niezgodne artefakty.
2. Ostrzegać, ale nie blokować, gdy zgodność jest niepewna.
3. Rozwiązywać wymagane zależności Modrinth.
4. Nie pozostawiać serwera w częściowo zmienionym stanie.
5. Automatycznie przywracać poprzedni zestaw plików po nieudanym uruchomieniu.
6. Chronić współdzielone zależności podczas usuwania dodatków.
7. Zapisywać ostatni potwierdzony działający zestaw dodatków.

## Poza zakresem

Plan nie obejmuje:

1. Hybrydowych runtime'ów łączących pluginy Paper z modami Fabric, Forge albo NeoForge.
2. Statycznej allowlisty lub denylisty nazw projektów.
3. Automatycznego instalowania wszystkich zależności opcjonalnych.
4. Gwarantowania zgodności logicznej dowolnej kombinacji modów przed jej uruchomieniem.
5. Snapshotu całej VM przed każdą instalacją pojedynczego dodatku.
6. Automatycznej zmiany głównej wersji Minecrafta lub runtime'u.
7. Instalowania plików z dowolnych adresów URL poza kontrolowanym mechanizmem Modrinth.

## Stan wyjściowy

Backend już:

1. Rozpoznaje Paper, Purpur, Fabric, Forge i NeoForge.
2. Rozdziela pluginy od modów.
3. Filtruje katalog Modrinth według wersji Minecrafta i loadera.
4. Ponownie sprawdza zgodność wersji projektu podczas instalacji.
5. Wybiera plik JAR z opublikowaną sumą SHA-512.
6. Przechowuje zawartość osobno dla każdej instancji serwera Minecraft.
7. Blokuje instalację tego samego projektu drugi raz.

Brakuje pełnej walidacji środowiska klient/serwer, zależności, konfliktów,
zgodności rzeczywiście uruchomionego runtime'u, transakcji plikowej, rollbacku i
ochrony zależności przy usuwaniu.

## Zasady projektowe

1. Backend jest jedynym autorytatywnym miejscem walidacji. GUI tylko prezentuje plan i wynik.
2. Każda instalacja ponownie sprawdza dane w Modrinth, nawet jeśli wcześniej wykonano wyszukiwanie.
3. Twarda blokada jest stosowana wyłącznie przy jednoznacznym dowodzie niezgodności.
4. Brak lub niejednoznaczność metadanych powoduje ostrzeżenie, nie automatyczne odrzucenie.
5. Administrator może wymusić tylko przypadki oznaczone jako ostrzeżenie. Nie może ominąć błędu sumy kontrolnej, niewłaściwego rodzaju dodatku ani potwierdzonego konfliktu.
6. Zmiana plików jest wykonywana dopiero po pobraniu i zweryfikowaniu całego zestawu.
7. Operacja dotyczy jednej wskazanej instancji Minecrafta i nie może wpływać na inne serwery na tej samej VM.
8. Jednocześnie może działać tylko jedna mutująca operacja zawartości dla danego serwera.
9. Ponowienie tego samego żądania jest idempotentne i zwraca stan istniejącej operacji.
10. Każda decyzja administratora i rollback pozostawiają rekord audytowy.

## Polityka blokad i ostrzeżeń

### Twarde blokady

Instalacja nie może być kontynuowana, gdy:

1. Rodzaj projektu nie odpowiada runtime'owi: plugin dla loadera modów albo mod dla Paper/Purpur.
2. Konkretna wersja artefaktu nie obsługuje wybranej wersji Minecrafta.
3. Konkretna wersja artefaktu nie obsługuje właściwego loadera.
4. Środowisko wersji Modrinth to `client_only` albo `singleplayer_only`.
5. Rzeczywisty runtime albo wersja serwera różnią się od konfiguracji użytej do utworzenia planu.
6. Pobranego pliku nie można zweryfikować za pomocą SHA-512.
7. Zainstalowany jest projekt wskazany przez Modrinth jako `incompatible`.
8. Plan wygasł albo zmienił się stan zainstalowanych dodatków od czasu jego utworzenia.
9. Trwa inna mutująca operacja dla tego samego serwera.

### Ostrzeżenia wymagające potwierdzenia

Instalacja może być kontynuowana przez administratora, gdy:

1. Środowisko wersji Modrinth to `unknown`.
2. Dodatek wymaga instalacji również u klienta.
3. Dodatek jest wersją `beta` albo `alpha`.
4. Wymagana zależność jest zewnętrzna i Modrinth nie udostępnia jej projektu lub wersji.
5. Plugin jest oznaczony tylko jako Purpur, a docelowym runtime'em jest Paper.
6. Metadane projektu są niepełne, ale konkretny artefakt ma zgodną wersję gry, loader i sumę kontrolną.

Potwierdzenie musi zawierać identyfikator planu, listę zaakceptowanych ostrzeżeń
i opcjonalną notatkę administratora. Nie może być globalnym przełącznikiem
wyłączającym walidację.

## Macierz runtime'ów

| Runtime serwera | Akceptowane loadery wersji Modrinth | Rodzaj zawartości |
|---|---|---|
| Paper | `paper`, `spigot`, `bukkit` | plugin |
| Purpur | `purpur`, `paper`, `spigot`, `bukkit` | plugin |
| Fabric | `fabric` | mod |
| Forge | `forge` | mod |
| NeoForge | `neoforge` | mod |

Plugin oznaczony wyłącznie jako `purpur` na Paper ma być ostrzeżeniem, a nie
automatycznie akceptowanym artefaktem. Forge i NeoForge pozostają osobnymi
loaderami, chyba że konkretna wersja projektu jawnie deklaruje oba.

## Polityka środowiska Modrinth

| Wartość `environment` | Decyzja | Informacja dla administratora |
|---|---|---|
| `client_only` | blokada | dodatek nie działa na serwerze dedykowanym |
| `singleplayer_only` | blokada | dodatek nie obsługuje serwera dedykowanego |
| `server_only` | zezwolenie | klient nie wymaga dodatku |
| `dedicated_server_only` | zezwolenie | przeznaczony dla serwera dedykowanego |
| `server_only_client_optional` | zezwolenie | instalacja klienta jest opcjonalna |
| `client_and_server` | ostrzeżenie | zgodna wersja jest wymagana u graczy |
| `client_or_server` | zezwolenie | może działać tylko po stronie serwera |
| `client_or_server_prefers_both` | ostrzeżenie | zalecana instalacja po obu stronach |
| `client_only_server_optional` | ostrzeżenie | instalacja serwerowa jest opcjonalna i może być zbędna |
| `unknown` | ostrzeżenie | autor nie określił środowiska |

Walidacja używa pola konkretnej wersji, a pole projektu jest tylko wartością
zapasową i zawsze powoduje zaznaczenie źródła decyzji w planie.

## Model zależności

### Zależności `required`

1. Resolver buduje skierowany graf zależności od wybranego projektu.
2. Dla każdego projektu wybiera wersję zgodną z tym samym runtime'em i wersją Minecrafta.
3. Już zainstalowana zgodna wersja jest używana ponownie.
4. Brakującą zależność dodaje do planu jako automatycznie instalowaną.
5. Niezgodna już zainstalowana wersja powoduje blokadę i czytelny opis konfliktu.
6. Zależność wskazana tylko przez nazwę zewnętrznego pliku powoduje ostrzeżenie i wymaga ręcznego potwierdzenia.

### Zależności `optional`

1. Są wyświetlane w planie jako domyślnie odznaczone.
2. Po zaznaczeniu przechodzą tę samą walidację co projekt główny.
3. Ich brak nigdy nie blokuje instalacji projektu głównego.

### Zależności `embedded`

1. Są prezentowane informacyjnie.
2. Nie są pobierane ani instalowane osobno.

### Zależności `incompatible`

1. Powodują blokadę tylko wtedy, gdy konfliktujący projekt jest zainstalowany albo znajduje się w tym samym planie.
2. Komunikat wskazuje oba projekty i wersje.

### Ograniczenia resolvera

1. Maksymalna głębokość grafu: 10.
2. Maksymalna liczba projektów w jednym planie: 100.
3. Cykle są wykrywane i raportowane bez zawieszania operacji.
4. Projekty współdzielone występują w planie tylko raz.
5. Wyniki zapytań Modrinth są krótko buforowane, ale instalacja wykonuje końcową rewalidację.
6. Odpowiedzi 429 i błędy przejściowe zwracają stan `verification unavailable`, bez mutowania serwera.

## Plan instalacji

Backend ma utworzyć niemutowalny, krótkotrwały plan zawierający co najmniej:

```json
{
  "schemaVersion": 1,
  "planId": "opaque-id",
  "serverId": "survival",
  "runtime": {
    "configured": "fabric",
    "observed": "fabric",
    "minecraftVersion": "1.21.4"
  },
  "rootProject": {
    "projectId": "...",
    "versionId": "..."
  },
  "artifacts": [],
  "requiredDependencies": [],
  "optionalDependencies": [],
  "conflicts": [],
  "warnings": [],
  "contentRevision": "sha256-of-current-manifest",
  "expiresAt": "ISO-8601"
}
```

`planId`, `contentRevision` i `expiresAt` zapobiegają wykonaniu starego planu po
zmianie konfiguracji. Backend przechowuje pełne dane planu; klient przesyła tylko
identyfikator, wybór zależności opcjonalnych i zaakceptowane ostrzeżenia.

## Przepływ instalacji

1. Administrator wybiera projekt w katalogu.
2. Backend pobiera aktualną konfigurację serwera i stan agenta.
3. Backend buduje graf zależności i plan instalacji.
4. GUI pokazuje runtime, wersję Minecrafta, środowisko, pliki, zależności, wymagania klienta, ostrzeżenia i konflikty.
5. Administrator wybiera zależności opcjonalne i zatwierdza ostrzeżenia.
6. Backend ponownie sprawdza ważność planu i blokuje mutacje danego serwera.
7. Agent pobiera wszystkie pliki do katalogu stagingowego.
8. Agent weryfikuje nazwy, rozmiary i SHA-512 wszystkich artefaktów.
9. Agent zapisuje kopię manifestu oraz wyłącznie plików, które zostaną zastąpione lub usunięte.
10. Agent atomowo aktywuje nowy zestaw plików.
11. Agent restartuje tylko wybraną instancję Minecrafta.
12. Backend czeka na wynik health checku i gotowość RCON.
13. Po sukcesie agent usuwa staging i lokalną kopię transakcyjną.
14. Po błędzie albo timeoutcie agent przywraca poprzednie pliki i manifest, ponownie uruchamia serwer i zapisuje wynik rollbacku.

## Transakcja plikowa i rollback

1. Katalog stagingowy ma znajdować się na tym samym systemie plików co katalog docelowy, aby końcowe przeniesienia były atomowe.
2. Pobieranie nigdy nie zapisuje bezpośrednio do aktywnego katalogu `mods` lub `plugins`.
3. Manifest zawiera projekt, wersję, nazwę pliku, SHA-512, pochodzenie instalacji i zależności odwrotne.
4. Rollback przywraca wyłącznie stan sprzed bieżącej transakcji.
5. Niepowodzenie rollbacku jest stanem krytycznym; serwer pozostaje zatrzymany, a GUI pokazuje instrukcję ręcznego odzyskania.
6. Timeout gotowości jest konfigurowalny per runtime, ale ma bezpieczną wartość domyślną.
7. Logi muszą wskazywać pierwszy błąd loadera i nie mogą ujawniać sekretów RCON ani tokenów.

## Bezpieczne usuwanie

1. Backend oblicza zależności odwrotne przed utworzeniem planu usunięcia.
2. Projekt wymagany przez inne dodatki nie może być usunięty samodzielnie.
3. GUI oferuje anulowanie albo usunięcie projektu wraz z zależnymi projektami.
4. Automatycznie zainstalowana zależność jest usuwana tylko wtedy, gdy nie wymaga jej żaden pozostały projekt.
5. Zależność zainstalowana ręcznie nie jest automatycznie usuwana.
6. Usuwanie korzysta z tego samego stagingu, health checku i rollbacku co instalacja.

## Rzeczywisty runtime jako źródło prawdy

Agent zarządzający ma raportować dla każdej instancji Minecrafta:

1. Identyfikator serwera.
2. Faktyczny typ runtime'u.
3. Wersję Minecrafta.
4. Wersję loadera lub build serwera, jeśli jest dostępny.
5. Identyfikator obrazu kontenera.
6. Rewizję aktywnego manifestu dodatków.

Backend porównuje te dane z metadanymi VM przed utworzeniem i przed wykonaniem
planu. Rozbieżność nie jest automatycznie naprawiana podczas instalacji; wymaga
odświeżenia stanu albo osobnej operacji naprawczej.

## Historia `last known working`

Po udanym health checku backend zapisuje:

1. Runtime i wersję Minecrafta.
2. Wersję obrazu i loadera.
3. Rewizję manifestu.
4. Projekty, wersje i sumy kontrolne.
5. Czas startu i wynik health checku.
6. Identyfikator operacji, która utworzyła stan.

GUI rozróżnia statusy:

| Status | Znaczenie |
|---|---|
| `Metadata compatible` | metadane deklarują zgodność, ale zestaw nie był jeszcze uruchomiony |
| `Last known working` | dokładnie ta rewizja manifestu osiągnęła gotowość |
| `Warning accepted` | administrator zaakceptował niejednoznaczną zgodność |
| `Failed and rolled back` | nowy zestaw nie uruchomił się, przywrócono poprzedni |
| `Recovery required` | rollback nie przywrócił gotowości |

Historia ma ograniczoną retencję i nie przechowuje binariów. Pliki potrzebne do
bieżącego rollbacku są lokalne i usuwane po sukcesie albo po potwierdzonym
odzyskaniu.

## Zmiany GUI

1. Wynik katalogu pokazuje runtime, wersję Minecrafta i środowisko klient/serwer.
2. `Install` najpierw otwiera plan, zamiast bezpośrednio mutować serwer.
3. Plan rozdziela projekt główny, wymagane zależności, opcjonalne zależności, konflikty i ostrzeżenia.
4. Twarde blokady nie mają aktywnego przycisku kontynuacji.
5. Ostrzeżenia wymagają osobnego potwierdzenia administratora.
6. Postęp pokazuje etapy: walidacja, pobieranie, weryfikacja, aktywacja, restart, health check i ewentualny rollback.
7. Lista zainstalowanych dodatków pokazuje, które projekty zostały dodane automatycznie jako zależności i przez co są wymagane.
8. Błąd startu pokazuje pierwszy istotny komunikat loadera oraz wynik rollbacku.

## API i model operacji

Docelowy podział odpowiedzialności:

1. `POST /minecraft/content/plan-install` tworzy plan bez mutacji VM.
2. `POST /minecraft/content/apply-install` wykonuje ważny plan.
3. `POST /minecraft/content/plan-remove` tworzy plan usunięcia.
4. `POST /minecraft/content/apply-remove` wykonuje plan usunięcia.
5. `GET /minecraft/content/operations/{id}` zwraca etap, postęp i wynik.
6. Istniejący endpoint zarządzania pozostaje zgodny podczas migracji GUI, ale docelowo deleguje do tego samego serwisu planowania i wykonania.

Nazwy tras mogą zostać dostosowane do obecnego routera. Ważne jest rozdzielenie
operacji planującej od mutującej oraz brak zaufania do listy artefaktów przesłanej
przez przeglądarkę.

## Fazy realizacji

### Faza 0: linia bazowa i kontrakty

1. Dodać fixture odpowiedzi Modrinth dla wszystkich loaderów, środowisk i rodzajów zależności.
2. Udokumentować aktualny manifest, metadane serwerów i protokół agenta.
3. Dodać test bezpośredniego wywołania API omijającego GUI.
4. Ustalić timeouty Modrinth, agenta, restartu i rollbacku.
5. Potwierdzić, że każda instancja Minecrafta ma osobny katalog i manifest.

Kryterium wyjścia: testy odtwarzają obecną instalację i usuwanie bez zmiany zachowania produkcyjnego.

### Faza 1: środowisko, runtime i macierz loaderów

1. Walidować `environment` konkretnej wersji.
2. Zawęzić automatyczną zgodność Paper/Purpur.
3. Dodać raport faktycznego runtime'u do agenta.
4. Wprowadzić twarde blokady i ostrzeżenia zgodnie z macierzami planu.
5. Rozszerzyć GUI o przyczynę decyzji i wymagania klienta.

Kryterium wyjścia: klient-only i zły loader są blokowane przez backend, a `unknown` pozostaje możliwy po potwierdzeniu.

### Faza 2: resolver zależności i modal planu

1. Zbudować ograniczony graf zależności.
2. Obsłużyć `required`, `optional`, `embedded` i `incompatible`.
3. Dodać model planu, TTL i rewizję zawartości.
4. Dodać wybór zależności opcjonalnych.
5. Zapisywać potwierdzenia ostrzeżeń.

Kryterium wyjścia: instalacja Fabric moda wymagającego Fabric API proponuje zgodną zależność, a bezpośrednie API nie może jej pominąć.

### Faza 3: transakcyjna synchronizacja i rollback

1. Dodać staging po stronie agenta.
2. Weryfikować wszystkie SHA-512 przed aktywacją.
3. Atomowo zamieniać manifest i pliki.
4. Dodać restart, health check i automatyczny rollback.
5. Raportować postęp i pierwszy istotny błąd loadera.

Kryterium wyjścia: celowo uszkodzony lub konfliktujący zestaw nie pozostawia częściowo zainstalowanych plików, a poprzedni serwer ponownie osiąga gotowość.

### Faza 4: bezpieczne usuwanie

1. Dodać zależności odwrotne.
2. Chronić współdzielone i ręcznie instalowane zależności.
3. Dodać plan usunięcia i potwierdzenie usuwania zależnych projektów.
4. Użyć tej samej transakcji i rollbacku co instalacja.

Kryterium wyjścia: nie można przypadkowo usunąć biblioteki wymaganej przez inny mod.

### Faza 5: ostatni działający zestaw i obserwowalność

1. Zapisywać `last known working`.
2. Pokazywać status zgodności przy każdym dodatku i serwerze.
3. Dodać ograniczoną historię operacji i rollbacków.
4. Dodać metryki czasu planowania, pobierania, startu i częstości rollbacków.

Kryterium wyjścia: administrator może wskazać ostatnią działającą rewizję i przyczynę nieudanego uaktualnienia bez analizowania metadanych GCE.

## Strategia wdrażania bez zbędnych blokad

1. Faza 1 początkowo działa w trybie obserwacyjnym i zapisuje decyzje bez blokowania, poza istniejącymi błędami rodzaju, loadera i wersji gry.
2. Po testach E2E włączane są blokady `client_only`, `singleplayer_only` i rozbieżności runtime'u.
3. Resolver zależności najpierw tylko pokazuje plan, następnie automatyzuje wyłącznie zależności `required` z jednoznacznym projektem Modrinth.
4. Niepełne metadane pozostają ostrzeżeniem wymagającym potwierdzenia.
5. Transakcyjna synchronizacja jest wdrażana per endpoint lub serwer, z możliwością powrotu do starego agenta do czasu pierwszej udanej transakcji.
6. Twarde blokady nie mają globalnego przełącznika wyłączenia.
7. Każda faza jest osobnym wdrożeniem i ma niezależny test rollbacku.

## Plan testów

### Testy jednostkowe backendu

1. Każdy runtime i każda wartość `environment`.
2. Zależności wymagane, opcjonalne, osadzone i konfliktujące.
3. Cykle, wspólne zależności, limit głębokości i limit projektów.
4. Paper kontra plugin tylko dla Purpur.
5. Forge kontra NeoForge.
6. Wygasły plan, zmieniona rewizja i zmieniony runtime.
7. Ponowione żądanie z tym samym identyfikatorem operacji.

### Testy integracyjne Modrinth

1. Poprawny artefakt i SHA-512.
2. Brak wersji dla loadera albo wersji Minecrafta.
3. Projekt client-only.
4. Brakująca zewnętrzna zależność.
5. Odpowiedzi 404, 429, 5xx, timeout i błędny JSON.
6. Zmiana wersji projektu między planem a wykonaniem.

### Testy agenta VM

1. Pobieranie do stagingu bez zmiany aktywnego katalogu.
2. Błędna suma kontrolna.
3. Awaria po częściowym pobraniu.
4. Atomowa aktywacja.
5. Timeout startu.
6. Udany i nieudany rollback.
7. Izolacja dwóch serwerów Minecraft na jednej VM.

### Testy E2E przez GUI

1. Paper z pluginem Bukkit/Paper.
2. Purpur z pluginem Paper i pluginem tylko dla Purpur.
3. Fabric z wymaganym Fabric API.
4. Forge z modem wymagającym instalacji klienta.
5. NeoForge i próba instalacji artefaktu wyłącznie Forge.
6. Projekt client-only.
7. Projekt z zależnością opcjonalną.
8. Konflikt z już zainstalowanym projektem.
9. Usunięcie zależności współdzielonej.
10. Instalacja powodująca błąd startu i automatyczny rollback.
11. Odświeżenie strony podczas każdej fazy operacji.
12. Ponowne kliknięcie `Install` i równoległa próba usunięcia.

### Test destrukcyjny

1. Utworzyć testowy serwer z działającym dodatkiem.
2. Zapisać jego rewizję jako `last known working`.
3. Wprowadzić kontrolowany artefakt powodujący błąd loadera po aktywacji.
4. Potwierdzić rollback plików i manifestu.
5. Potwierdzić ponowną gotowość RCON i brak wpływu na inne serwery.
6. Wymusić błąd samego rollbacku i potwierdzić stan `Recovery required` bez dalszych automatycznych mutacji.

## Kryteria akceptacji całości

1. Loader, wersja gry i rodzaj dodatku są ponownie sprawdzane podczas instalacji.
2. Client-only nie może zostać zainstalowany na serwerze przez GUI ani bezpośrednie API.
3. `unknown` nie jest bezwarunkowo blokowany.
4. Wymagane zależności są widoczne i rozwiązywane deterministycznie.
5. Zależności opcjonalne nie są automatycznie instalowane.
6. Nie można usunąć projektu wymaganego przez inny zainstalowany projekt bez jawnego planu kaskadowego.
7. Żaden błąd pobierania, sumy kontrolnej lub startu nie pozostawia częściowego zestawu plików.
8. Poprzedni działający stan jest automatycznie przywracany po nieudanej instalacji.
9. Inna instancja Minecrafta na tej samej VM pozostaje niezmieniona.
10. GUI po odświeżeniu pokazuje aktualny etap i wynik operacji.
11. Administrator widzi przyczynę blokady, treść ostrzeżenia i wynik rollbacku.
12. Wszystkie decyzje są egzekwowane przez backend i objęte testami bezpośredniego API.

## Ryzyka i ograniczenia

1. Metadane Modrinth mogą być błędne lub niepełne; dlatego `unknown` pozostaje ostrzeżeniem.
2. Nawet poprawne metadane nie gwarantują zgodności logicznej dwóch modów; ostateczną weryfikacją jest start i health check.
3. Duże modpacki mogą przekroczyć limit pojedynczego planu; powinny być obsługiwane osobnym importem modpacka, nie przez podnoszenie limitu bez końca.
4. Rollback nie naprawi zmian danych świata wykonanych już przez uruchomiony mod. Health check musi zakończyć się przed udostępnieniem serwera graczom, ale pełną ochronę świata nadal zapewnia okresowy backup.
5. Modrinth API ma limity i może być niedostępne; planowanie ma kończyć się bez mutacji, z możliwością bezpiecznego ponowienia.
6. Plugin może być formalnie zgodny z API, ale zależeć od zachowania konkretnego forka; takie przypadki pozostają ostrzeżeniem i są rejestrowane jako wynik działania.

## Decyzje wymagane przed implementacją

1. Docelowy czas oczekiwania na gotowość dla Paper/Purpur i loaderów modów.
2. Lokalizacja oraz maksymalny rozmiar katalogu transakcyjnego na dysku stanu.
3. Retencja historii `last known working` i rekordów audytowych.
4. Czy zależność zewnętrzna bez projektu Modrinth wymaga jedynie potwierdzenia, czy wcześniejszego ręcznego wskazania pliku.
5. Czy wersje `beta` i `alpha` mają być domyślnie ukryte w katalogu, czy tylko oznaczone ostrzeżeniem.
6. Maksymalna liczba opcjonalnych zależności pokazywanych w pojedynczym modalu bez dodatkowej paginacji.
