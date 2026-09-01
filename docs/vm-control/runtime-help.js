(() => {
  "use strict";

  const RUNTIME_HELP = Object.freeze({
    paper: {
      name: "Paper",
      summary: "The recommended default for a performant multiplayer server that uses plugins and normally accepts unmodified Minecraft clients.",
      extensionModel: "Paper, Spigot and Bukkit plugins. Fabric, Forge and NeoForge mods are not supported.",
      clientCompatibility: "Most plugins are server-side, so players can usually connect with an unmodified client. A plugin may still require a resource pack or companion client feature.",
      chooseWhen: "Choose Paper for administration plugins, permissions, minigames, performance tuning and a mostly vanilla client experience.",
      migration: "Moving between Paper and Purpur is usually low risk. Do not move a world containing modded blocks or items from Fabric, Forge or NeoForge to Paper without a tested backup.",
      docs: "https://docs.papermc.io/paper/"
    },
    purpur: {
      name: "Purpur",
      summary: "A configurable drop-in replacement for Paper that adds optional gameplay controls while retaining the Paper plugin ecosystem.",
      extensionModel: "Purpur, Paper, Spigot and Bukkit plugins. It does not load Fabric, Forge or NeoForge mods.",
      clientCompatibility: "Like Paper, it normally accepts unmodified clients. Individual plugins or enabled gameplay features can introduce additional client requirements.",
      chooseWhen: "Choose Purpur when Paper-compatible plugins are required and you also want extensive server-side gameplay customization through Purpur configuration.",
      migration: "Paper plugins normally work, but a poorly implemented plugin can reject Paper forks. Back up the server before changing runtime or enabling behavior-changing options.",
      docs: "https://purpurmc.org/docs/purpur/"
    },
    fabric: {
      name: "Fabric",
      summary: "A lightweight mod loader suited to focused mod sets, optimization mods and projects that update quickly to newer Minecraft versions.",
      extensionModel: "Fabric mods only. Many mods also require Fabric API. Paper, Spigot and Bukkit plugins are not supported.",
      clientCompatibility: "Server-only mods can allow unmodified clients. Mods that add content, networking or client features must be installed in compatible versions on both client and server.",
      chooseWhen: "Choose Fabric when the selected mods explicitly publish Fabric builds, especially for lightweight, technical, optimization or Vanilla+ setups.",
      migration: "The Minecraft version, Fabric loader, Fabric API, every mod and all dependencies must be compatible. Removing world-content mods can damage or erase modded data.",
      docs: "https://docs.fabricmc.net/"
    },
    forge: {
      name: "Forge",
      summary: "A long-established mod loader with a broad ecosystem, especially important for existing and older modpacks.",
      extensionModel: "Forge mods only. Paper plugins and Fabric or NeoForge-specific mod files are not supported unless their authors explicitly provide compatibility.",
      clientCompatibility: "Most content modpacks require the same compatible mod set on the client and server. Mods marked as server-only are the exception.",
      chooseWhen: "Choose Forge when a chosen mod or modpack explicitly requires it, particularly established packs for older Minecraft releases or Minecraft 1.20.1.",
      migration: "Match the exact Minecraft and Forge versions plus every dependency. Forge packs can need more memory and longer startup time; always back up worlds before upgrades.",
      docs: "https://docs.minecraftforge.net/en/latest/"
    },
    neoforge: {
      name: "NeoForge",
      summary: "A modern mod loader from the NeoForged ecosystem, generally preferred when a newer modpack explicitly targets NeoForge.",
      extensionModel: "NeoForge mods only. Do not assume that a Forge JAR is compatible unless the mod author explicitly supports both loaders.",
      clientCompatibility: "Content and networking mods generally require matching client installations. Server-only NeoForge mods may still permit unmodified clients.",
      chooseWhen: "Choose NeoForge for modern packs that publish NeoForge builds. NeoForged recommends Forge rather than NeoForge for Minecraft 1.20.1 and NeoForge for supported newer releases.",
      migration: "Treat Forge and NeoForge as separate loaders. Verify every mod, dependency, Minecraft version and Java requirement before migrating, and keep a restorable world backup.",
      docs: "https://docs.neoforged.net/user/docs/"
    }
  });

  function addDetail(container, heading, text) {
    const section = document.createElement("section");
    const title = document.createElement("h3");
    const body = document.createElement("p");
    title.textContent = heading;
    body.textContent = text;
    section.append(title, body);
    container.append(section);
  }

  function initializeRuntimeHelp() {
    const select = document.querySelector("#software-minecraft-server-type");
    const openButton = document.querySelector("#minecraft-runtime-info");
    const dialog = document.querySelector("#minecraft-runtime-info-dialog");
    const title = document.querySelector("#minecraft-runtime-info-title");
    const summary = document.querySelector("#minecraft-runtime-info-summary");
    const details = document.querySelector("#minecraft-runtime-info-details");
    const docs = document.querySelector("#minecraft-runtime-info-docs");

    if (!select || !openButton || !dialog || !title || !summary || !details || !docs) return;

    const selectedRuntime = () => RUNTIME_HELP[select.value] || RUNTIME_HELP.paper;
    const updateButtonLabel = () => {
      const runtime = selectedRuntime();
      openButton.setAttribute("aria-label", `Show information about the ${runtime.name} Minecraft runtime`);
      openButton.title = `About ${runtime.name}`;
    };

    const renderDialog = () => {
      const runtime = selectedRuntime();
      title.textContent = runtime.name;
      summary.textContent = runtime.summary;
      details.replaceChildren();
      addDetail(details, "Extensions", runtime.extensionModel);
      addDetail(details, "Client compatibility", runtime.clientCompatibility);
      addDetail(details, "Choose this runtime when", runtime.chooseWhen);
      addDetail(details, "Compatibility and migration", runtime.migration);
      docs.href = runtime.docs;
    };

    select.addEventListener("change", updateButtonLabel);
    openButton.addEventListener("click", () => {
      renderDialog();
      dialog.returnValue = "";
      if (!dialog.open) dialog.showModal();
    });
    dialog.addEventListener("close", () => openButton.focus());
    updateButtonLabel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeRuntimeHelp, {once: true});
  } else {
    initializeRuntimeHelp();
  }
})();
