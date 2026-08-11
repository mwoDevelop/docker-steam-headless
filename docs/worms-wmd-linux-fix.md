# Robaki W.M.D. Poprawka dotycząca uruchamiania Linuksa

## Problem

`Worms W.M.D.` można poprawnie zainstalować na Steamie, ale natywna kompilacja Linuksa może zakończyć się kilka sekund po uruchomieniu.

W kontenerze `steam-headless` było to spowodowane niekompatybilnymi starszymi bibliotekami dołączonymi do gry:

```text
./Worms W.M.Dx64: error while loading shared libraries: libidn.so.11: cannot open shared object file: No such file or directory
./Worms W.M.Dx64: .../lib/libstdc++.so.6: version `GLIBCXX_3.4.30' not found
./Worms W.M.Dx64: error while loading shared libraries: libwavpack.so.1: cannot open shared object file: No such file or directory
```

Kontener działa na Debianie 12, który udostępnia `libidn.so.12` i nowszy system `libstdc++`. Gra oczekuje starszego `libidn.so.11`, po czym ładuje własne, stare `libstdc++.so.6`, które koliduje z bieżącymi bibliotekami systemowymi. Środowisko wykonawcze Steam może również nie udostępnić `libwavpack.so.1` grze, nawet jeśli biblioteka jest dostępna w kontenerze.

## Napraw działającą maszynę wirtualną

Uruchom to na stacji roboczej z dostępem `gcloud` do maszyny wirtualnej:

```bash
gcloud compute ssh steam \
  --zone=europe-central2-b \
  --project=docker-414215 \
  --command '
CID=$(sudo docker ps -qf name=steam-headless | head -n1)
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

## Polecenia ręcznej weryfikacji

Aby potwierdzić pierwotny problem:

```bash
gcloud compute ssh steam \
  --zone=europe-central2-b \
  --project=docker-414215 \
  --command '
CID=$(sudo docker ps -qf name=steam-headless | head -n1)
sudo docker exec "$CID" bash -lc "
  cd /mnt/games/GameLibrary/Steam/steamapps/common/WormsWMD
  ldd \"Worms W.M.Dx64\" 2>&1 | grep -E \"libidn|libwavpack|GLIBCXX\" || true
"
'
```

Aby sprawdzić, czy poprawka została już zastosowana:

```bash
gcloud compute ssh steam \
  --zone=europe-central2-b \
  --project=docker-414215 \
  --command '
CID=$(sudo docker ps -qf name=steam-headless | head -n1)
sudo docker exec "$CID" bash -lc "
  cd /mnt/games/GameLibrary/Steam/steamapps/common/WormsWMD
  ls -l lib/libidn.so.11 lib/libstdc++.so.6.bundled-disabled lib/libwavpack.so.1
"
'
```

## Przywracanie poprawki

W razie potrzeby:

```bash
gcloud compute ssh steam \
  --zone=europe-central2-b \
  --project=docker-414215 \
  --command '
CID=$(sudo docker ps -qf name=steam-headless | head -n1)
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
