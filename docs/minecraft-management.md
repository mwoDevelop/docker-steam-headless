# Minecraft management panel

The Minecraft management panel is available at `docs/vm-control/minecraft-admin.html` through the **Open management controls** link in VM Control.

- Access is granted per Google account by an administrator in `admin.html`.
- Administrator accounts always have Minecraft management access.
- Cloud Run authorizes every request; the browser never receives the RCON password.
- The VM runs the RCON client locally inside the `itzg/minecraft-server` container. TCP `25575` is not published and no firewall rule is added for it.
- The panel supports console commands, player listing, whitelist changes, OP changes, and a container restart.

For an already-created VM, use **Enable management agent** once and restart the VM from the main GUI. Newly created VMs install the agent automatically during startup.
