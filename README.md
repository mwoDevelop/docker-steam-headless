# Bezgłowy serwis parowy

![](./images/banner.jpg)

Zdalny serwer strumieniowego przesyłania gier.

Graj w swoje gry w przeglądarce z dźwiękiem lub poprzez Steam Link lub Moonlight. Graj z innego klienta Steam za pomocą Steam Remote Play.

Z łatwością wdróż instancję Steam Docker w ciągu kilku sekund.

## Dokumentacja

To repozytorium zawiera nadrzędny kontener Steam Headless i specyficzny dla forka
Kontrola maszyny wirtualnej Google Cloud. Zacznij od [documentation index](./docs/README.md).

### Kontrola maszyny wirtualnej Google Cloud

- [Open VM Control](https://mwodevelop.github.io/docker-steam-headless/vm-control/)
- [Administrator panel](https://mwodevelop.github.io/docker-steam-headless/vm-control/admin.html)
- [Architecture and deployment](./docs/cloud-run-vm-control.md)
- [Minecraft management](./docs/minecraft-management.md)
- [Troubleshooting](./docs/troubleshooting.md)

Panel administratora zarządza cyklem życia maszyny wirtualnej, przypisaniem punktów końcowych, kopiami zapasowymi,
obrazy wykonawcze, aplikacje, serwery Minecraft i dowody zgodności.
Zwykli użytkownicy mają informacje o instancji tylko do odczytu i łącza dostępu na żywo.

### Instalacja kontenera nadrzędnego

- [Docker Compose](./docs/docker-compose.md)
- [Unraid](./docs/unraid.md)
- [Ubuntu Server](./docs/ubuntu-server.md)
- [Kubernetes](./docs/k8s.md)

## Cechy:
- Klient Steam skonfigurowany do działania w systemie Linux z Protonem
- Serwer kompatybilny z Moonlight do łatwego przesyłania strumieniowego na zdalny pulpit
- Łatwa instalacja EmeDeck, Heroic i Lutris poprzez Flatpak
- Pełny dostęp wideo/audio przez Internet noVNC do pulpitu Xfce4
- Obsługa procesorów graficznych NVIDIA, AMD i Intel
- Pełna obsługa kontrolera
- Wsparcie dla instalacji Flatpak i Appimage
- Dostęp do roota
- Oparty na Debianie Trixie

---
## Uwagi:

### OPROGRAMOWANIE DODATKOWE:
Jeśli chcesz zainstalować dodatkowe aplikacje, możesz wygenerować skrypt w katalogu `~/init.d` kończący się na ".sh".
Zostanie to wykonane podczas uruchamiania kontenera.

Możesz także instalować aplikacje za pomocą interfejsu WebUI w obszarze **Aplikacje > System > Oprogramowanie**. Tam możesz zainstalować inne programy uruchamiające gry, takie jak Lutris, Heroic lub EmuDeck.

### ŚCIEŻKI PRZECHOWYWANIA:
Wszystko, co chcesz zapisać w tym kontenerze, powinno być przechowywane w katalogu domowym lub w określonym miejscu montażu kontenera dokowanego.
Wszystkie pliki przechowywane poza Twoim katalogiem domowym nie są trwałe i zostaną usunięte, jeśli nastąpi aktualizacja kontenera lub zmienisz coś w szablonie.

### BIBLIOTEKA GIER:
Zalecane jest zamontowanie biblioteki gier na `/mnt/games` i skonfigurowanie Steam tak, aby dodała tę ścieżkę.

### APLIKACJE AUTOSTARTU:
W tym kontenerze Steam jest skonfigurowany do automatycznego uruchamiania. Jeśli chcesz dodać dodatkowe usługi, które będą uruchamiane automatycznie,
dodaj je w obszarze **Aplikacje > Ustawienia > Sesja i uruchamianie** w interfejsie WebUI.

### TRYB SIECIOWY:
Jeśli chcesz używać kontenera jako urządzenia hosta Steam Remote Play (wcześniej „In Home Streaming”), powinieneś utworzyć niestandardową sieć i przypisać temu kontenerowi jego własny adres IP. Jeśli tego nie zrobisz, ruch będzie kierowany przez Internet, ponieważ Steam będzie myślał, że jesteś w innej sieci.

### KORZYSTANIE Z SERWERA HOSTA X:
Jeśli Twój host już korzysta z X, możesz po prostu z niego skorzystać. Aby to zrobić, skonfiguruj:
- WYŚWIETLACZ=:0
    **(Variable)** - *Configures the sceen to use the primary display. Set this to whatever your host is using*
- TRYB=wtórny
    **(Variable)** - *Configures the container to not start an X server of its own*
- HOST_DBUS=prawda
    **(Variable)** - *Optional - Configures the container to use the host dbus process*
- /run/dbus:/run/dbus:ro
    **(Mount)**  - *Optional - Configures the container to use the host dbus process*


---
## Instalacja:
- [Choose an installation guide](./docs/README.md#upstream-container-installation)


---
## Działa lokalnie:

Dla środowiska programistycznego utworzyłem skrypt w katalogu devops.


---
## ZROBIĆ:
- Usuń SSH
- Wymagaj od użytkownika wprowadzenia hasła do sudo
- Dokument, jak uruchomić ten kontener:
    - Other server OS
    - TrueNAS Scale 
