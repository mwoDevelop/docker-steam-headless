# Panel zarządzania Minecraftem

Panel zarządzania Minecraft jest dostępny pod adresem `docs/vm-control/minecraft-admin.html` poprzez połączenie **Otwórz zarządzanie zarządzanie** w VM Control.

- Dostęp jest dostępny na koncie Google przez administratora w `admin.html`.
- Konta administratorów zawsze mają dostęp do zarządzania Minecraftem.
- Cloud Run autoryzuje każde pobieranie; Przeglądarka nie została dostarczona hasła RCON.
— Maszyna wirtualna uruchamiająca klienta RCON lokalnie w kontenerze `itzg/minecraft-server`. TCP `25575` nie jest publikowany i nie jest dodawany dla innej konkretnej zapory sieciowej.
- Panel obsługujący konsolę, listę odtwarzaczy, zmianę na ekranie, zmianę OP i udostępnienie kontenera.

W przypadku już zorganizowanej maszyny wirtualnej raz opcja **Włącz agenta zarządzania** i uruchom ponownie maszynę wirtualną z poziomu interfejsu GUI. Nowo utworzone maszyny wirtualne instalują agenta automatycznie podczas uruchamiania.
