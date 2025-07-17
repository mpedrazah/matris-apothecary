document.addEventListener("DOMContentLoaded", function () {
    const specialsBanner = document.getElementById("specials-banner");
    const seasonalSpecials = document.getElementById("seasonal-specials");
    const easterSpecials = document.getElementById("easter-specials");
    const stPatricksSpecials = document.getElementById("stpatricks-specials");
    const mardiGrasSpecials = document.getElementById("mardigras-specials");

    // ✅ Toggle these manually
    const isEasterActive = false;
    const isStPatricksActive = false;
    const isMardiGrasActive = false

    let specialsActive = false;

    // ⛔ Hide all by default
    if (easterSpecials) {
        easterSpecials.classList.add("hidden");
        easterSpecials.style.display = "none";
    }

    if (stPatricksSpecials) {
        stPatricksSpecials.classList.add("hidden");
        stPatricksSpecials.style.display = "none";
    }

    if (mardiGrasSpecials) {
        mardiGrasSpecials.classList.add("hidden");
        mardiGrasSpecials.style.display = "none";
    }

    // ✅ Show active sections
    if (isEasterActive && easterSpecials) {
        easterSpecials.classList.remove("hidden");
        easterSpecials.style.display = "block";
        specialsActive = true;
    }

    if (isStPatricksActive && stPatricksSpecials) {
        stPatricksSpecials.classList.remove("hidden");
        stPatricksSpecials.style.display = "block";
        specialsActive = true;
    }

    if (isMardiGrasActive && mardiGrasSpecials) {
        mardiGrasSpecials.classList.remove("hidden");
        mardiGrasSpecials.style.display = "block";
        specialsActive = true;
    }

    // ✅ Show seasonal specials section and banner if any are active
    if (specialsActive) {
        seasonalSpecials.classList.remove("hidden");
        specialsBanner?.classList.remove("hidden");
    } else {
        seasonalSpecials.classList.add("hidden");
        seasonalSpecials.style.display = "none";
        specialsBanner?.classList.add("hidden");
        specialsBanner.style.display = "none";
    }

    console.log("✅ Specials toggled:", {
        easter: isEasterActive,
        stPatricks: isStPatricksActive,
        mardiGras: isMardiGrasActive,
    });
});
