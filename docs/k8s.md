#Kubernetes

Masz klaster w domu i chcesz go poprosić o parę bezgłową?

Wymagania
- Wtyczka urządzenia NVIDIA (jeśli jest to oddzielne narzędzie graficzne NVIDIA) https://github.com/NVIDIA/k8s-device-plugin
- Zajęcia z przechowywania

Zadania
1. Skonfiguruj zestaw stanowy według upodobań. Rzeczy warte uwagi:
    - CPU & Memory
    - Env vars (see compose-files/.env.example for documentation; keep real passwords in a local Secret / untracked env)
2. Zmień PCV według upodobań elektrycznych. Rzeczy warte uwagi:
    - Storage Class
    - Size
3. Wdróż go: `kubectl create -f k8s-files/*`
