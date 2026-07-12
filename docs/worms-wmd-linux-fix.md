# Worms W.M.D. Linux launch fix

## Problem

`Worms W.M.D.` can install correctly in Steam, but the native Linux build may exit a few seconds after launch.

On the `steam-headless` container this was caused by incompatible legacy libraries bundled with the game:

```text
./Worms W.M.Dx64: error while loading shared libraries: libidn.so.11: cannot open shared object file: No such file or directory
./Worms W.M.Dx64: .../lib/libstdc++.so.6: version `GLIBCXX_3.4.30' not found
./Worms W.M.Dx64: error while loading shared libraries: libwavpack.so.1: cannot open shared object file: No such file or directory
```

The container runs Debian 12, which provides `libidn.so.12` and a newer system `libstdc++`. The game expects the older `libidn.so.11`, then loads its own old `libstdc++.so.6`, which conflicts with current system libraries. Steam's runtime can also fail to expose `libwavpack.so.1` to the game, even when the library is available in the container.

## Fix on a running VM

Run this from the workstation with `gcloud` access to the VM:

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

After this, launch the game from Steam again.

## Manual verification commands

To confirm the original issue:

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

To check whether the fix is already applied:

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

## Reverting the fix

If needed:

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
