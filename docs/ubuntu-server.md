# Konfiguracja serwera Ubuntu

Zastosowanie z tych urządzeń, aby sprawdzić **Steam Headless** w systemie Ubuntu Server.

> ⚠️ **Uwaga**
>
> W tych krokach za skomplikowanych, że uruchamiasz minimalną instalację **Serwera Ubuntu** **bez żadnego środowiska graficznego**.
> Ta opcja będzie **nie będzie** na Ubuntu Desktop.

---

## ZAINSTALUJ STEROWNIK NVIDIA:

Dostępny jest system serwerowy, wykorzystujący wariant sterownika NVIDIA `-server`, który może powodować problemy ze zgodnością.
Zamiast tego zainstaluj standardowy sterownik **bez zalecanych dodatków**:

```bash
apt install --no-install-recommends nvidia-driver-570
```

> 🔍 Zapraszam do `570` z najnowszym dostępem do wyposażenia.

Aby znaleźć najnowsze wersje programów (innych niż `-server`, innych niż `-open`), uruchom:

```bash
apt-cache search ^nvidia-driver- | awk '{print $1}' | grep -vE '(-server|-open)' | xargs -n1 apt-cache policy | awk '/^nvidia-driver-/{driver=$1} /Candidate:/ {print driver, $2}'
```

---

## ZAINSTALUJ DOKER:

Zainstaluj `docker-ce` na swoim urządzeniu Ubuntu, postępując zgodnie z [official Docker instructions](https://docs.docker.com/engine/install/ubuntu/).

Instalacja została zainstalowana także `docker-compose-plugin` zgodnie z dokumentacją Dockera.

---

## ZAINSTALUJ ZESTAW NARZĘDZI KONTENERÓW NVIDIA

Aby włączyć obsługę elektryczną w kontenerach Docker, zainstaluj [NVIDIA Container Toolkit](https://github.com/NVIDIA/nvidia-container-toolkit?tab=readme-ov-file).

Postępowanie zgodnie z [APT-based installation steps](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html#installing-with-apt), które można zastosować w dokumentacji.

Po zainstalowaniu konfiguracji Dockera tak, aby korzystać z oprogramowania ze środowiska wykonawczego NVIDIA:

```bash
sudo nvidia-ctk runtime configure --runtime=docker
```

> 💡 *Możesz* także kontener bez środowiska wykonawczego NVIDIA, usuwając komentarz do urządzenia `/dev/nvidia*` w pliku Compose — ale takie rozwiązanie nie jest **nie**.

---

## KONFIGURUJ KOMPOZYCJĘ DOCKERA:

Po zainstalowaniu Dockera przejdź do sekcji [Compose Files](./docker-compose.md) i wybierz opcję konfiguracji dla posiadanego sprzętu.
