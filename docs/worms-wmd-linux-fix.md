# Poprawka uruchamiania Worms W.M.D. na Linuksie

## Kiedy stosować

Natywna wersja `Worms W.M.D.` może zakończyć działanie kilka sekund po
uruchomieniu. Opisana poprawka dotyczy przypadku, w którym log lub `ldd`
potwierdza co najmniej jeden z poniższych błędów:

```text
./Worms W.M.Dx64: error while loading shared libraries: libidn.so.11: cannot open shared object file: No such file or directory
./Worms W.M.Dx64: .../lib/libstdc++.so.6: version `GLIBCXX_3.4.30' not found
./Worms W.M.Dx64: error while loading shared libraries: libwavpack.so.1: cannot open shared object file: No such file or directory
```

Projekt domyślnie używa zmiennego obrazu `josh5/steam-headless:latest`.
Zawartość obrazu może się zmienić, dlatego przed zastosowaniem poprawki należy
wykonać opisaną niżej weryfikację. Nie należy stosować jej do innych błędów
uruchamiania gry.

W środowisku, w którym odtworzono problem, gra oczekiwała starszego
`libidn.so.11`, ładowała dołączony, niekompatybilny `libstdc++.so.6` i nie
widziała `libwavpack.so.1` dostępnego w kontenerze.

## Wybór maszyny wirtualnej

Nazwy VM i strefy są dynamiczne. Odczytaj je z panelu administracyjnego albo
poleceniem:

```bash
gcloud compute instances list \
  --project=docker-414215 \
  --filter='name~^steam-mwo-'
```

Ustaw wartości odpowiadające właściwej VM:

```bash
PROJECT_ID="docker-414215"
VM_NAME="steam-mwo-vm1-t4-europe-central2-c"
ZONE="europe-central2-c"
```

VM musi być uruchomiona, a gra zainstalowana.

## Weryfikacja problemu

```bash
gcloud compute ssh "$VM_NAME" \
  --zone="$ZONE" \
  --project="$PROJECT_ID" \
  --command '
CID=$(sudo docker ps -qf name=steam-headless | head -n1)
test -n "$CID" || { echo "Kontener steam-headless nie działa" >&2; exit 1; }
sudo docker exec "$CID" bash -lc "
  cd /mnt/games/GameLibrary/Steam/steamapps/common/WormsWMD
  ldd \"Worms W.M.Dx64\" 2>&1 | grep -E \"libidn|libwavpack|GLIBCXX\" || true
"
'
```

Jeżeli wynik nie zawiera problemów wymienionych w sekcji „Kiedy stosować”, nie
stosuj poniższej poprawki.

## Zastosowanie poprawki

```bash
gcloud compute ssh "$VM_NAME" \
  --zone="$ZONE" \
  --project="$PROJECT_ID" \
  --command '
CID=$(sudo docker ps -qf name=steam-headless | head -n1)
test -n "$CID" || { echo "Kontener steam-headless nie działa" >&2; exit 1; }
sudo docker exec "$CID" bash -lc "
  set -euo pipefail
  cd /mnt/games/GameLibrary/Steam/steamapps/common/WormsWMD

  if [ ! -e lib/libidn.so.11 ]; then
    ln -s /lib/x86_64-linux-gnu/libidn.so.12 lib/libidn.so.11
  fi

  if [ -f lib/libstdc++.so.6 ]; then
    mv lib/libstdc++.so.6 lib/libstdc++.so.6.bundled-disabled
  fi

  if [ ! -e lib/libwavpack.so.1 ]; then
    cp -L /lib/x86_64-linux-gnu/libwavpack.so.1 lib/libwavpack.so.1
    chown default:default lib/libwavpack.so.1 || true
    chmod 0755 lib/libwavpack.so.1
  fi
"
'
```

Następnie ponownie uruchom grę ze Steam.

Pliki gry znajdują się na dysku stanu, więc poprawka powinna przetrwać zwykłe
zatrzymanie, uruchomienie i migrację VM. Aktualizacja gry lub sprawdzenie
spójności plików w Steam może przywrócić oryginalne biblioteki; w takim
przypadku wykonaj ponownie weryfikację przed ponownym zastosowaniem poprawki.

## Sprawdzenie zastosowanej poprawki

```bash
gcloud compute ssh "$VM_NAME" \
  --zone="$ZONE" \
  --project="$PROJECT_ID" \
  --command '
CID=$(sudo docker ps -qf name=steam-headless | head -n1)
test -n "$CID" || { echo "Kontener steam-headless nie działa" >&2; exit 1; }
sudo docker exec "$CID" bash -lc "
  cd /mnt/games/GameLibrary/Steam/steamapps/common/WormsWMD
  ls -l lib/libidn.so.11 lib/libstdc++.so.6.bundled-disabled lib/libwavpack.so.1
"
'
```

## Wycofanie poprawki

```bash
gcloud compute ssh "$VM_NAME" \
  --zone="$ZONE" \
  --project="$PROJECT_ID" \
  --command '
CID=$(sudo docker ps -qf name=steam-headless | head -n1)
test -n "$CID" || { echo "Kontener steam-headless nie działa" >&2; exit 1; }
sudo docker exec "$CID" bash -lc "
  set -euo pipefail
  cd /mnt/games/GameLibrary/Steam/steamapps/common/WormsWMD

  rm -f lib/libidn.so.11

  if [ -f lib/libstdc++.so.6.bundled-disabled ] && [ ! -e lib/libstdc++.so.6 ]; then
    mv lib/libstdc++.so.6.bundled-disabled lib/libstdc++.so.6
  fi

  rm -f lib/libwavpack.so.1
"
'
```
