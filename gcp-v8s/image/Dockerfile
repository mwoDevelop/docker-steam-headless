FROM josh5/steam-headless:latest

USER root

RUN set -eux; \
    flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo; \
    flatpak install -y --system flathub org.prismlauncher.PrismLauncher; \
    flatpak list --app --system | grep -i "org.prismlauncher.PrismLauncher"
