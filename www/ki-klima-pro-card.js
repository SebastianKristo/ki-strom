/**
 * ki-klima-pro-card.js  (v2 — for custom integration «KI Energi»)
 * Ett kort for hele KI-klima- og energisystemet.
 *
 * Kortet snakker bare med entitetene integrasjonen lager. Gamle
 * input_boolean/input_number/input_datetime-navn fra YAML-pakken oversettes
 * automatisk til switch/number/time/datetime, så alle gamle referanser i
 * kortet virker uendret.
 *
 *   Oversikt      status, timebudsjett, graf, modus, varmtvann
 *   Soner         måltemperatur, KI/manuell, overstyring med utløp
 *   Energi        dynamisk grense, månedens topper, grafer, statistikk
 *   Varmtvann     legionellastatus og tvungen syklus
 *   Tanker        hva motoren tenker akkurat nå + beslutningslogg
 *   Oppsett       alle brytere, tider, tidskonstanter, diagnostikk
 *
 * Kopier til /config/www/ki-klima-pro-card.js og legg til som ressurs:
 *   URL:  /local/ki-klima-pro-card.js?v=1.0.0
 *   Type: JavaScript Module
 *
 * Config:  type: custom:ki-klima-pro-card
 */

const KI_PRO_VERSJON = "2.8.0";

console.info(
  `%c KI-KLIMA-PRO-CARD %c ${KI_PRO_VERSJON} `,
  "background:#28282a;color:#fafbfc;padding:2px 6px;border-radius:6px 0 0 6px;font-weight:600",
  "background:#4caf50;color:#fff;padding:2px 6px;border-radius:0 6px 6px 0;font-weight:600"
);

const FANER = [
  { id: "oversikt", navn: "Oversikt", icon: "mdi:view-dashboard" },
  { id: "soner", navn: "Soner", icon: "mdi:home-thermometer" },
  { id: "energi", navn: "Energi", icon: "mdi:flash" },
  { id: "varmtvann", navn: "Vann og bad", icon: "mdi:water-boiler" },
  { id: "tanker", navn: "Tanker", icon: "mdi:head-cog" },
  { id: "oppsett", navn: "Oppsett", icon: "mdi:tune" },
  { id: "avansert", navn: "Avansert", icon: "mdi:wrench-cog" },
];

// Entitetene motoren bruker per sone. Brukes bare til diagnostikk i kortet,
// så manglende sensorer blir synlige uten å måtte grave i pyscript-fila.
const SONE_ENTITETER = {
  stue_panelovn: ["climate.stue_panelovn", "sensor.stue_panelovn_current_power", "sensor.stue_panelovn_control_signal"],
  stue_oljefyr: ["climate.stue_oljefyr", "sensor.stue_oljefyr_current_power", "sensor.stue_oljefyr_control_signal"],
  trappegang: ["climate.trappegang_panelovn", "sensor.trappegang_panelovn_current_power", "sensor.trappegang_panelovn_control_signal"],
  kjokken_panelovn: ["climate.kjokken_panelovn", "sensor.kjokken_panelovn_current_power", "sensor.kjokken_panelovn_control_signal"],
  cybele: ["climate.cybele_panelovn", "sensor.cybele_panelovn_current_power", "sensor.cybele_panelovn_control_signal"],
  sebastian: ["climate.sebastian_panelovn", "sensor.sebastian_panelovn_stikkontakt_power", "sensor.panelovn_temperature"],
  kjokken_gulv: ["climate.kjokken_gulvvarme", "sensor.kjokken_gulvvarme_power", "sensor.kjokken_gulvvarme_air_temperature"],
  bad_gulv: ["climate.bad_gulvvarme", "sensor.bad_gulvvarme_power", "sensor.bad_gulvvarme_temperature"],
  vaskegang_gulv: ["climate.vaskegang_gulvvarme", "sensor.vaskegang_gulvvarme_power", "sensor.vaskegang_gulvvarme_air_temperature"],
  do_gulv: ["climate.do_gulvvarme", "sensor.do_gulvvarme_power", "sensor.do_gulvvarme_room_temperature"],
};

const TIMESMALER_KANDIDATER = ["sensor.ki_time_energi"];

// Oversetting fra pakkens gamle helper-domener til integrasjonens entiteter.
const DATO_TID = new Set(["ki_vvb_siste_godkjente_syklus", "ki_vvb_oppvarming_startet",
  "ki_vvb_boost_til", "ki_hjemkomst_planlagt"]);
const mapId = (id) => {
  if (!id || typeof id !== "string") return id;
  const [dom, obj] = id.split(".");
  if (dom === "input_boolean") return `switch.${obj}`;
  if (dom === "input_number") return `number.${obj}`;
  if (dom === "input_text") return `text.${obj}`;
  if (dom === "input_datetime") return `${DATO_TID.has(obj) ? "datetime" : "time"}.${obj}`;
  return id;
};
// Tjenester fra pyscript/script-tiden → integrasjonens tjenester
const TJENESTER = {
  "pyscript.ki_overstyr": ["ki_energi", "overstyr"],
  "pyscript.ki_fjern_overstyring": ["ki_energi", "fjern_overstyring"],
  "pyscript.ki_nullstill_laering": ["ki_energi", "nullstill_laering"],
  "script.ki_vvb_boost": ["ki_energi", "vvb_boost"],
  "script.ki_vvb_avbryt_boost": ["ki_energi", "vvb_avbryt_boost"],
  "script.ki_vvb_tving_syklus_na": ["ki_energi", "vvb_tving_syklus"],
  "script.ki_sett_standardverdier": ["ki_energi", "sett_standardverdier"],
};

const SONE_TEKST = {
  gronn: "God margin", gul: "Nærmer seg grensen", oransje: "Liten margin",
  rod: "Fare for ny topp", kritisk: "Kritisk", fallback: "Trygg fallback",
  av: "Motoren er av",
};

const HANDLING = {
  normal: { tekst: "Normal", k: "ok" },
  senket: { tekst: "Senket", k: "advarsel" },
  vindu: { tekst: "Vindu åpent", k: "feil" },
  manuell: { tekst: "Manuell", k: "noytral" },
  utilgjengelig: { tekst: "Utilgjengelig", k: "feil" },
  utsatt: { tekst: "Utsatt", k: "advarsel" },
  "på": { tekst: "På", k: "ok" },
  av: { tekst: "Av", k: "noytral" },
};

// Settpunkt-helpere per sonenøkkel, slik motoren bruker dem
const SONE_HELPERE = {
  stue_panelovn: [["ki_temp_stue_dag", "Dag"], ["ki_temp_stue_natt", "Natt"]],
  stue_oljefyr: [["ki_temp_stue_dag", "Dag"], ["ki_temp_stue_natt", "Natt"]],
  trappegang: [["ki_temp_trappegang_dag", "Dag"], ["ki_temp_trappegang_natt", "Natt"]],
  kjokken_panelovn: [["ki_temp_kjokken_panelovn_dag", "Dag"], ["ki_temp_kjokken_panelovn_natt", "Natt"]],
  cybele: [["ki_temp_cybele_dag", "Dag"], ["ki_temp_cybele_natt", "Natt"], ["ki_temp_cybele_borte", "Borte"]],
  sebastian: [["ki_temp_sebastian_dag", "Dag"], ["ki_temp_sebastian_natt", "Natt"]],
  kjokken_gulv: [["ki_temp_kjokken", "Settpunkt"]],
  bad_gulv: [["ki_temp_bad", "Settpunkt"]],
  vaskegang_gulv: [["ki_temp_vaskegang", "Settpunkt"]],
  do_gulv: [["ki_temp_do", "Settpunkt"]],
};

const SONE_STYR = {
  stue_panelovn: "ki_styr_stue_panelovn", stue_oljefyr: "ki_styr_stue_oljefyr",
  trappegang: "ki_styr_trappegang_panelovn", kjokken_panelovn: "ki_styr_kjokken_panelovn",
  cybele: "ki_styr_cybele_panelovn", sebastian: "ki_styr_sebastian_panelovn",
  kjokken_gulv: "ki_styr_kjokken_gulvvarme", bad_gulv: "ki_styr_bad_gulvvarme",
  vaskegang_gulv: "ki_styr_vaskegang_gulvvarme", do_gulv: "ki_styr_do_gulvvarme",
};

// Forklaringer bak spørsmålstegnene. Kort, konkret, og om hva som faktisk
// skjer — ikke en omskriving av navnet på feltet.
// Ikon per blokkoverskrift. Settes inn automatisk i _tegn().
const HODE_IKON = {
  "Vurdering per sone": "mdi:home-thermometer", "Varsler": "mdi:bell-outline", "Varmtvann": "mdi:water-boiler",
  "Varmtvann, avansert": "mdi:water-boiler-alert", "Timebudsjett": "mdi:timer-sand", "Tiltak akkurat nå": "mdi:lightning-bolt",
  "Tider": "mdi:clock-outline", "Terskler for fargesonene": "mdi:palette", "Soner": "mdi:floor-plan",
  "Slik tenker motoren nå": "mdi:head-cog", "Siste 12 timer": "mdi:chart-line", "Prognose og reserver": "mdi:chart-timeline-variant",
  "Prisstyring": "mdi:cash-clock", "Motorens råtilstand": "mdi:code-json", "Moduser og unntak": "mdi:tune-variant",
  "Modus": "mdi:toggle-switch-outline", "Legionella": "mdi:bacteria-outline", "Innlærte tidskonstanter": "mdi:school-outline",
  "Håndklevarmer": "mdi:radiator", "Hvem styrer ovnene": "mdi:account-cog", "Helgevarsler": "mdi:bag-suitcase",
  "Handlinger": "mdi:gesture-tap-button", "Handling": "mdi:gesture-tap", "Grenser": "mdi:speedometer",
  "Gardiner stue": "mdi:curtains", "Forventet effekt": "mdi:chart-bell-curve", "Entiteter per sone": "mdi:link-variant",
  "Effekt siste 6 timer": "mdi:chart-areaspline", "Dynamisk grense": "mdi:arrow-expand-vertical", "Dusjvinduer": "mdi:shower-head",
  "Diagnostikk": "mdi:stethoscope", "Denne måneden": "mdi:calendar-month", "Brytere": "mdi:toggle-switch",
  "Beslutningslogg": "mdi:text-box-outline", "Tarifftabell": "mdi:table", "Motor": "mdi:engine", "Varme og komfort": "mdi:radiator",
  "Helg og sommer": "mdi:calendar-weekend", "Vann og bad": "mdi:shower", "Varslinger": "mdi:bell-ring-outline",
  "Dag og natt": "mdi:theme-light-dark", "Cybele": "mdi:account", "Sebastian": "mdi:account-school", "Stue og vindu": "mdi:sofa",
  "Leggetid": "mdi:bed", "Elbil": "mdi:ev-station",
};

const HJELP = {
  venter_svar: "Søndag morgen spør systemet om dere kommer hjem. Fram til du svarer, eller til svarfristen går ut, står dette på «Ja». Svarer du ikke, avsluttes helgemodus automatisk ved fristen, slik at huset er varmt når dere kommer.",
  beredskap: "En sjekk før du lar motoren overta: at den rapporterer status, at den har funnet en timesmåler, at tidskonstantene har nok målinger bak seg, og at ingen ovner står avslått. «Lærer fortsatt» betyr at den fungerer, men at nattsenkingsvurderingene ennå bygger på standardverdier.",
  skyggemodus: "Motoren regner ut alt og skriver til loggen, men rører ingen ovner. Slik kan du lese beslutningene i noen uker og se om du er enig før huset merker dem. Varmtvann, håndklevarmer og gardiner styres uansett.",
  dynamisk_grense: "Elvia fakturerer etter snittet av de tre høyeste døgnmaksene fra tre ulike dager. Motoren måler hver hele klokketime selv, husker døgnmaks per dato, og regner ut hvor høyt DAGENS døgnmaks kan bli uten at snittet passerer ønsket trinn (minus reserve). Timer opp til dagens allerede registrerte døgnmaks koster ingenting ekstra og senker ingen ovner. Den absolutte timegrensen gjelder alltid i tillegg. Registrerte tall og prognoser holdes adskilt.",
  tariff: "Øvre grense i kW → fastledd kr/mnd inkl. avgifter, f.eks. «2:150,5:250,10:420». Nøyaktig på grensen regnes som trinnet over. Snitt over siste grense = ukjent trinn (motoren finner ikke på satser, og styrer da etter absolutt grense).",
  tillatt_effekt: "Gjenstående kWh delt på gjenstående tid av timen. Verdien er kuttet ved timegrensen og regner aldri med mindre enn et kvarter igjen — ellers ville de siste minuttene av en rolig time gitt et vanvittig høyt tall som ovnene uansett ikke rekker å bruke.",
  uregulert: "Alt huset bruker som motoren ikke styrer: komfyr, oppvaskmaskin, elektronikk, lading. Regnes som total effekt minus summen av det den styrer. Dette er grunnlaget for hele prognosen.",
  tidskonstant: "Hvor lenge rommet holder på overtemperaturen sin. Måles ved å se hvor fort det kjøles ned når varmen er av. Lang tidskonstant betyr at nattsenking sjelden lønner seg, fordi gjenoppvarmingen skjer til dyrere dagtariff.",
  komfortvekt: "Hvor tungt et temperaturavvik veier mot prioriteten når budsjettet fordeles. Høyt tall gjør at et kaldt rom med lav prioritet likevel går foran et rom som allerede er varmt.",
  shed: "Hvor mange grader motoren får senke når budsjettet ikke strekker til. Gulvvarme tåler mer enn panelovner, fordi tregheten gjør at det ikke merkes i rommet på kort sikt.",
  vvb_terskel: "Hvor mange watt som må til før en oppvarming regnes som reell. Står den for lavt, telles standby som en fullført syklus, og legionellasikringen blir bekreftet på falskt grunnlag.",
  vvb_billige: "Marginalprisen er energipris pluss energiledd. Under Norgespris er energiprisen flat, så det er bare nettleiens dag- og nattskille som skiller timene — rangeringen faller derfor naturlig ned på natt og helg.",
  vvb_handling: "Berederen har ingen temperatursensor. Systemet bekrefter legionellasikring ved å se et fullført på→av-forløp, som betyr at termostaten nådde settpunktet. Det forutsetter at termostaten fysisk står på 65–70 °C — det kan ikke Home Assistant kontrollere. Energimotoren skriver aldri til berederen; den reserverer bare effekt.",
  vvb_syklus: "Berederen har ingen temperatursensor, men den har en termostat. Når bryteren står på og effekten faller til null, har termostaten koblet ut fordi vannet har nådd settpunktet. Det kalles metning, og er en direkte måling av at berederen er ferdig — også for legionella, forutsatt at termostaten fysisk står på 65–70 grader. Et ødelagt element gir samme signatur, så systemet krever at den HAR trukket effekt først. Har den aldri gjort det, er det en feil og ikke metning.",
  gardiner: "I fyringssesongen lukkes gardinene når sola er nede for å begrense varmetapet gjennom glassveggen, og åpnes på dagen for gratis solvarme. Er det bitende kaldt holdes de lukket også på dagen. Utenfor sesongen styres de bare i sommermodus, da som solskjerming.",
  handkle: "Klimastyringen eier denne bryteren. Når «KI styrer» er av, slås håndklevarmeren på igjen automatisk hver gang den går av — den er da ment å stå på konstant. Slå på KI-styring for å bruke tidsvinduene i stedet.",
  overtakelse: "Motoren er den eneste som skriver til ovnene. Bryteren er det motsatte av skyggemodus: på betyr at den faktisk setter settpunkt, av betyr at den bare regner og logger. Soner med «KI styrer» av røres aldri uansett.",
  lagring: "Innlærte lastprofiler, tidskonstanter, overstyringer og beslutningslogg lagres i Home Assistants .storage-mappe og overlever omstart og oppdatering av integrasjonen.",
  malekilde: "Forbruk denne timen måles direkte mot strømmålerens energiregister — motoren husker verdien ved timeskiftet og trekker fra. Svarer ikke registeret, brukes et anslag fra øyeblikkseffekt, som er merkbart mindre presist.",
  handlinger: "Entiteter og husets data endres under Innstillinger → Integrasjoner → KI Energi → Konfigurer. Nullstilling av tidskonstanter betyr at motoren må lære huset på nytt, og at nattsenkingen faller tilbake på standardverdier i mellomtiden — bruk det bare hvis tallene ser åpenbart feil ut.",
  leggetid: "Starter kveldssenkingen i rommet med én gang, i stedet for å vente til fast leggetid. Rommet varmes opp igjen til vanlig vekketid. Trykk igjen for å avbryte.",
  standardverdier: "Setter alle innstillinger tilbake til de anbefalte utgangsverdiene. Entiteter og husets data ligger i integrasjonens konfigurasjon og røres ikke.",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (v, d = 1) => { const n = Number(v); return isFinite(n) ? n.toFixed(d).replace(".", ",") : "–"; };

class KiKlimaProCard extends HTMLElement {
  static getConfigElement() { return document.createElement("ki-klima-pro-card-editor"); }
  static getStubConfig() { return { type: "custom:ki-klima-pro-card" }; }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._bygd = false;
    this._sig = "";
    this._fane = "oversikt";
    this._apne = new Set();
    this._hist = null;
    this._histTid = 0;
    this._hjelpApen = new Set();
    this._kollaps = this._lesKollaps();
    this._ov = {};
  }

  setConfig(config) {
    this._config = Object.assign({ title: "", default_tab: "oversikt", remember_tab: true }, config || {});
    this._fane = this._lesFane() || this._config.default_tab;
    this._bygd = false;
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }

  getCardSize() { return 20; }

  _lesFane() {
    if (this._config && this._config.remember_tab === false) return null;
    try { return window.localStorage.getItem("ki-klima-pro:fane"); } catch (e) { return null; }
  }
  _lesKollaps() {
    try { return JSON.parse(window.localStorage.getItem("ki-klima-pro:kollaps") || "{}"); } catch (e) { return {}; }
  }
  _lagreKollaps() {
    try { window.localStorage.setItem("ki-klima-pro:kollaps", JSON.stringify(this._kollaps || {})); } catch (e) { /* ignorer */ }
  }

  // 24-timers linje med markører for klokkeslett-entiteter. [[id, etikett, klasse?], ...]
  _tidslinje(punkter, spenn = []) {
    const min = (id) => {
      const st = this._st(id); if (!st) return null;
      const m = /^(\d{1,2}):(\d{2})/.exec(st.state); return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const naa = new Date(); const naaMin = naa.getHours() * 60 + naa.getMinutes();
    const pct = (m) => (m / 1440 * 100).toFixed(2);
    const sp = spenn.map(([fraId, tilId, kl]) => {
      const a = min(fraId), b = min(tilId); if (a == null || b == null) return "";
      if (b >= a) return `<div class="tl-spenn ${kl || ""}" style="left:${pct(a)}%;width:${pct(b - a)}%"></div>`;
      return `<div class="tl-spenn ${kl || ""}" style="left:${pct(a)}%;width:${pct(1440 - a)}%"></div>
              <div class="tl-spenn ${kl || ""}" style="left:0;width:${pct(b)}%"></div>`;
    }).join("");
    const mk = punkter.map(([id, etikett, kl], i) => {
      const m = min(id); if (m == null) return "";
      const kl_ = ["over", "under", "over2"][i % 3];
      return `<div class="tl-mark ${kl || ""}" style="left:${pct(m)}%" title="${esc(etikett)} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}">
        <i></i><span class="${kl_}">${esc(etikett)} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}</span></div>`;
    }).join("");
    return `<div class="tidslinje">
      <div class="tl-spor">${sp}${mk}<div class="tl-naa" style="left:${pct(naaMin)}%"></div></div>
      <div class="tl-akse"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    </div>`;
  }

  // Døgnplan: én rad per person/ting, 24-timers bånd med fargede spenn og markører. Klarere enn én linje.
  // rader: [{navn, spenn:[[fraId, tilId, klasse, tekst]], mark:[[id, tekst, klasse]]}]
  _dognplan(rader) {
    const min = (id) => {
      const st = this._st(id); if (!st) return null;
      const m = /^(\d{1,2}):(\d{2})/.exec(st.state); return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const naa = new Date(); const naaMin = naa.getHours() * 60 + naa.getMinutes();
    const pct = (m) => (m / 1440 * 100).toFixed(2);
    const kl = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const rad = (r) => {
      const sp = (r.spenn || []).map(([fraId, tilId, k, tekst]) => {
        const a = min(fraId), b = min(tilId); if (a == null || b == null) return "";
        const boks = (l, w, t) => `<div class="dp-spenn ${k || ""}" style="left:${pct(l)}%;width:${pct(w)}%" title="${esc(t)}"><span>${esc(t)}</span></div>`;
        const t = `${tekst || ""} ${kl(a)}–${kl(b)}`.trim();
        if (b >= a) return boks(a, b - a, t);
        return boks(a, 1440 - a, t) + boks(0, b, t);
      }).join("");
      const mk = (r.mark || []).map(([id, tekst, k]) => {
        const m = min(id); if (m == null) return "";
        return `<div class="dp-mark ${k || ""}" style="left:${pct(m)}%" title="${esc(tekst)} ${kl(m)}"><i></i><span>${esc(tekst)} ${kl(m)}</span></div>`;
      }).join("");
      return `<div class="dp-rad"><div class="dp-navn">${esc(r.navn)}</div>
        <div class="dp-spor">${sp}${mk}<div class="dp-naa" style="left:${pct(naaMin)}%"></div></div></div>`;
    };
    return `<div class="dognplan">${rader.map(rad).join("")}
      <div class="dp-rad dp-akse"><div class="dp-navn"></div><div class="dp-spor"><span>00</span><span>03</span><span>06</span><span>09</span><span>12</span><span>15</span><span>18</span><span>21</span><span>24</span></div></div>
    </div>`;
  }

  // 12-månedersstripe der [fra .. til] er markert (kan gå over nyttår).
  _manedStripe(fraId, tilId, etikett) {
    const fra = Math.round(this._n(fraId)), til = Math.round(this._n(tilId));
    const naa = new Date().getMonth() + 1;
    const inne = (m) => isFinite(fra) && isFinite(til) && (fra <= til ? (m >= fra && m <= til) : (m >= fra || m <= til));
    const venter = this._mndValg && this._mndValg.fraId === fraId ? this._mndValg.fra : null;
    return `<div class="mstripe">
      ${["Jan", "Feb", "Mar", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Des"].map((b, i) =>
        `<div class="mnd ${inne(i + 1) ? "inne" : ""} ${i + 1 === naa ? "naa" : ""} ${venter === i + 1 ? "venter" : ""}"
              data-handling="mnd" data-fra="${fraId}" data-til="${tilId}" data-mnd="${i + 1}"><span>${b}</span></div>`).join("")}
    </div><div class="stripeforklaring"><span><i class="s-valgt"></i>${esc(etikett || "Aktiv")}</span>
      <span>${venter ? `Start satt til måned ${venter} — trykk sluttmåned` : "Trykk startmåned, så sluttmåned"}</span></div>`;
  }

  // Sammenleggbar underseksjon inne i en blokk. Husker posisjonen som blokkene.
  _sub(id, tittel, innhold, apenStandard = false, ekstra = "") {
    const apen = this._kollaps[id] !== undefined ? this._kollaps[id] : apenStandard;
    return `<div class="sub-seksjon ${apen ? "" : "lukket"}">
      <div class="subhode" data-handling="subkollaps" data-id="${esc(id)}"><span>${tittel}</span>${ekstra}<ha-icon class="kollapsikon" icon="mdi:chevron-down"></ha-icon></div>
      <div class="subkropp">${innhold}</div>
    </div>`;
  }

  _lagreFane(v) {
    if (this._config.remember_tab === false) return;
    try { window.localStorage.setItem("ki-klima-pro:fane", v); } catch (e) { /* ignorer */ }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._bygd) this._bygg();
    let sig = this._fane + "|" + (this._underfane || "") + "|";
    for (const id of this._fulgt) sig += ((hass.states[mapId(id)] || {}).state || "-") + ",";
    if (sig !== this._sig) {
      this._sig = sig;
      // Står markøren i et inputfelt (klokkeslett), venter vi med å tegne på nytt til feltet
      // er forlatt — ellers lukkes velgeren hver gang en sensor oppdateres.
      const aktiv = this._rot && this._rot.activeElement;
      if (aktiv && (aktiv.tagName === "INPUT" || aktiv.tagName === "TEXTAREA" || aktiv.tagName === "SELECT")) { this._ventTegn = true; return; }
      this._tegn();
    }
  }

  // Spørsmålstegn som folder ut en forklaring.
  _hj(id) {
    return HJELP[id] ? `<span class="hjelp" data-handling="hjelp" data-id="${id}">?</span>` : "";
  }
  _hjTekst(id) {
    return this._hjelpApen && this._hjelpApen.has(id)
      ? `<div class="hjelptekst">${esc(HJELP[id])}</div>` : "";
  }

  _st(id) { return this._hass.states[mapId(id)]; }

  // Alle tjenestekall går her, så domener og entitets-ID-er oversettes ett sted.
  _kall(domene, tjeneste, data = {}) {
    const n = TJENESTER[`${domene}.${tjeneste}`];
    if (n) [domene, tjeneste] = n;
    if (domene === "input_boolean") domene = "switch";
    else if (domene === "input_number") { domene = "number"; tjeneste = "set_value"; }
    else if (domene === "input_text") { domene = "text"; tjeneste = "set_value"; }
    else if (domene === "input_datetime") {
      const obj = String(data.entity_id || "").split(".")[1];
      domene = DATO_TID.has(obj) ? "datetime" : "time";
      tjeneste = "set_value";
      if (domene === "time") data = { entity_id: data.entity_id, time: data.time };
      else data = { entity_id: data.entity_id, datetime: data.datetime || data.timestamp };
    }
    if (data.entity_id) data = Object.assign({}, data, { entity_id: mapId(data.entity_id) });
    return this._hass.callService(domene, tjeneste, data);
  }
  _s(id, d = "–") { const s = this._st(id); return s && !["unknown", "unavailable"].includes(s.state) ? s.state : d; }
  _n(id, d = NaN) { const s = this._st(id); const v = s ? Number(s.state) : NaN; return isFinite(v) ? v : d; }
  _a(id, navn, d) { const s = this._st(id); return s && s.attributes[navn] !== undefined ? s.attributes[navn] : d; }
  _pa(id) { const s = this._st(id); return !!s && s.state === "on"; }

  /* ------------------------------------------------------------ */

  _bygg() {
    this._fulgt = new Set([
      "sensor.ki_energi_status", "sensor.ki_laster", "sensor.ki_beslutningslogg",
      "sensor.ki_bereder", "sensor.ki_tidskonstanter", "sensor.ki_klima_status",
      "sensor.ki_uregulert_effekt", "sensor.ki_styrt_effekt", "sensor.ki_hvitevarer_effekt",
      "sensor.ki_prognose", "sensor.ki_besparelse",
      "sensor.strommaler_effekt", "sensor.ki_time_energi",
      "sensor.ki_estimert_timesforbruk",
      "sensor.outdoor_meter_temperature",
      "sensor.nettleie_elvia_kapasitetstrinn", "sensor.nettleie_elvia_margin_til_neste_trinn",
      "sensor.nettleie_elvia_toppforbruk", "sensor.nettleie_elvia_toppforbruk_2",
      "sensor.nettleie_elvia_toppforbruk_3",
      "sensor.ki_vvb_legionella_status", "sensor.ki_vvb_dager_siden_siste_syklus",
      "sensor.varmtvannsbereder_power", "switch.varmtvannsbereder",
      "binary_sensor.ki_vvb_oppvarming_aktiv", "binary_sensor.ki_vvb_legionella_ok",
      "input_boolean.ki_vvb_tvungen_syklus_aktiv", "input_boolean.ki_vvb_kritisk_varslet",
      "input_boolean.ki_vvb_prisstyring", "input_boolean.ki_vvb_alltid_pa",
      "binary_sensor.ki_vvb_billig_time_na", "binary_sensor.ki_vvb_boost_aktiv",
      "binary_sensor.ki_vvb_mettet", "binary_sensor.ki_vvb_i_vindu",
      "binary_sensor.ki_vvb_ferdig_i_vinduet", "binary_sensor.ki_vvb_ingen_respons",
      "binary_sensor.ki_vvb_legionella_forfalt", "sensor.ki_vvb_oppvarming_minutter",
      "input_boolean.ki_vvb_har_trukket_effekt", "input_boolean.ki_vvb_folg_spotpris",
      "input_datetime.ki_vvb_siste_godkjente_syklus",
      "binary_sensor.ki_vvb_bor_varme", "sensor.ki_vvb_forklaring",
      "sensor.ki_vvb_billige_timer",
      "input_boolean.ki_energi_hovedbryter", "input_boolean.ki_skyggemodus",
      "sensor.ki_overgang_klar",
      "input_boolean.ki_hjemkomst_aktiv", "input_datetime.ki_hjemkomst_planlagt",
      "input_boolean.ki_nattsenk_aktiv", "input_boolean.ki_sommer_auto", "input_boolean.ki_helg_auto",
      "input_boolean.ki_vvb_legionella_aktiv", "input_number.ki_stat_spart_kr",
      "input_number.ki_stat_komfortavvik", "input_number.ki_trinn_kostnad_diff",
      "input_number.ki_helg_auto_timer", "input_number.ki_sommer_start_maned",
      "input_number.ki_sommer_slutt_maned", "input_number.ki_sommer_ute_grense",
      "input_number.ki_gardin_ute_grense", "input_number.ki_temp_helg_bad",
      "input_datetime.ki_hjemkomst_tid", "input_datetime.ki_cybele_borte_fra",
      "input_datetime.ki_cybele_borte_til", "input_boolean.ki_helgemodus",
      "input_boolean.ki_sommermodus", "input_boolean.ki_sebastian_ferie",
      "input_boolean.ki_helg_senk_gulvvarme", "binary_sensor.ki_alle_borte",
      "input_boolean.ki_dynamisk_grense", "input_boolean.ki_prediktiv_forvarming",
      "input_boolean.ki_laering_tau", "input_boolean.ki_solkompensasjon",
      "input_boolean.ki_nattsenk_okonomi", "input_boolean.ki_energi_varsler",
      "input_boolean.ki_styr_gardiner", "input_boolean.ki_styr_hanklevarmer",
      "switch.hanklevarmer", "sensor.hanklevarmer_power",
      "input_number.ki_maks_time_kwh", "input_number.ki_mal_snitt_kwh",
      "input_number.ki_min_time_kwh", "input_number.ki_reserve_uregulert_kwh",
      "input_number.ki_komfort_vekt", "input_number.ki_shed_gulv_maks",
      "input_number.ki_shed_panel_maks", "input_number.ki_natt_senk_ute_grense",
      "input_number.ki_stue_reduksjon", "input_number.ki_stat_unngatte_topper",
      "input_number.ki_stat_shed_hendelser", "input_number.ki_stat_flyttet_kwh",
      "sensor.ki_bereder", "sensor.ki_hanklevarmer", "sensor.ki_gardiner", "sensor.ki_vvb_billige_timer",
      "input_number.ki_gardin_slutt_maned", "input_datetime.ki_gardin_apne_tidligst", "input_datetime.ki_gardin_lukk_senest",
      "sensor.ki_nettleie", "input_text.ki_tariff_tabell", "input_number.ki_mal_trinn_kw", "input_number.ki_reserve_topp_kwh",
      "input_boolean.ki_tillat_dyrere_trinn",
      "input_boolean.ki_elbil_natt", "input_number.ki_elbil_effekt_kw", "input_datetime.ki_elbil_fra", "input_datetime.ki_elbil_til",
      "input_boolean.ki_vindu_stopp", "input_number.ki_vindu_forsinkelse_min", "input_number.ki_vindu_temp",
      "input_boolean.ki_helg_spor_torsdag", "input_boolean.ki_helg_spor_fredag",
      "input_boolean.ki_varsel_effekt", "input_boolean.ki_varsel_helg", "input_boolean.ki_varsel_hjemkomst",
      "input_boolean.ki_varsel_sommer", "input_boolean.ki_varsel_vvb", "input_boolean.ki_varsel_hanklevarmer",
      "input_datetime.ki_tid_dag_start", "input_datetime.ki_tid_natt_start",
      "input_datetime.ki_cybele_dag", "input_datetime.ki_cybele_natt",
      "input_datetime.ki_sebastian_vekking", "input_datetime.ki_sebastian_vekking_helg",
      "input_datetime.ki_sebastian_natt", "input_datetime.ki_stue_reduksjon_fra",
      "input_number.ki_sone_gul", "input_number.ki_sone_oransje", "input_number.ki_sone_rod",
      "input_number.ki_reserve_frokost_kwh", "input_number.ki_reserve_middag_kwh",
      "input_number.ki_gardin_start_maned",
      "input_number.ki_gardin_slutt_maned", "input_number.ki_hanklevarmer_maks_pa_tid",
      "input_number.ki_vvb_metning_terskel_w", "input_number.ki_vvb_maks_min_uten_effekt",
      "input_number.ki_vvb_maks_oppvarming_min", "input_number.ki_vvb_maks_dager",
      "input_number.ki_vvb_intervall_dager", "input_number.vvb_billigste_timer_dogn",
      "input_datetime.ki_vvb_vindu_start", "input_datetime.ki_vvb_klar_innen",
      "input_number.ki_vvb_effekt_kw", "input_number.ki_vvb_boost_minutter",
      "input_number.ki_temp_helg", "input_number.ki_temp_helg_gulvvarme",
      "input_number.ki_temp_sommer",
      "input_datetime.ki_frokost_start", "input_datetime.ki_frokost_slutt",
      "input_datetime.ki_middag_start", "input_datetime.ki_middag_slutt",
      "input_datetime.ki_helg_varsel_tid", "input_datetime.ki_helg_varsel_tid_torsdag", "input_datetime.ki_helg_sporsmal_tid",
      "input_datetime.ki_helg_frist_tid",
      "input_datetime.ki_hanklevarmer_morgen_start", "input_datetime.ki_hanklevarmer_morgen_slutt",
      "input_datetime.ki_hanklevarmer_kveld_start", "input_datetime.ki_hanklevarmer_kveld_slutt",
      "sensor.strommaler_imported_energy", "sensor.ki_beslutningslogg",
      "input_boolean.ki_helg_venter_svar",
    ]);
    TIMESMALER_KANDIDATER.forEach((id) => this._fulgt.add(id));
    Object.values(SONE_STYR).forEach((n) => this._fulgt.add(`input_boolean.${n}`));
    Object.values(SONE_HELPERE).flat().forEach(([n]) => this._fulgt.add(`input_number.${n}`));

    this.shadowRoot.innerHTML = `<style>${KiKlimaProCard.stil}</style>
      <ha-card><div class="wrap">
        ${this._config.title ? `<div class="tittel">${esc(this._config.title)}</div>` : ""}
        <div id="hero"></div>
        <div class="faner">${FANER.map((f) => `
          <div class="fane" data-handling="fane" data-fane="${f.id}">
            <ha-icon icon="${f.icon}"></ha-icon><span>${f.navn}</span>
          </div>`).join("")}</div>
        <div id="innhold"></div>
      </div></ha-card>`;

    this._rot = this.shadowRoot;
    this._rot.addEventListener("click", (e) => this._klikk(e));
    this._rot.addEventListener("change", (e) => this._endre(e));
    this._rot.addEventListener("focusout", () => {
      if (this._ventTegn) { this._ventTegn = false; setTimeout(() => this._tegn(), 250); }
    });
    this._bygd = true;
  }

  /* ------------------------------------------------------------ */

  _tegn() {
    if (!this._hass || !this._bygd) return;
    this._rot.querySelectorAll(".fane").forEach((el) => el.classList.toggle("aktiv", el.dataset.fane === this._fane));
    this._tegnHero();
    const ut = { oversikt: "_oversikt", soner: "_soner", energi: "_energi",
                 varmtvann: "_varmtvann", tanker: "_tanker", oppsett: "_oppsett",
                 avansert: "_avansert" }[this._fane];
    this._rot.getElementById("innhold").innerHTML = this[ut]();
    this._rot.querySelectorAll(".hode > span:first-child").forEach((sp) => {
      if (sp.querySelector("ha-icon")) return;
      const tittel = (sp.childNodes[0] && sp.childNodes[0].textContent || "").trim();
      const ikon = HODE_IKON[tittel];
      if (ikon) sp.insertAdjacentHTML("afterbegin", `<ha-icon class="hodeikon" icon="${ikon}"></ha-icon>`);
    });
    // Sammenleggbare blokker: alle faner unntatt Oversikt. Husker posisjonen per overskrift.
    if (this._fane !== "oversikt") {
      this._rot.querySelectorAll("#innhold .blokk").forEach((bl) => {
        const hode = bl.querySelector(":scope > .hode");
        if (!hode || hode.dataset.handling) return;
        const sp = hode.querySelector("span:first-child");
        const id = this._fane + ":" + ((sp && sp.textContent) || "").replace(/\?/g, "").trim();
        hode.dataset.handling = "kollaps"; hode.dataset.id = id;
        hode.insertAdjacentHTML("beforeend", `<ha-icon class="kollapsikon" icon="mdi:chevron-down"></ha-icon>`);
        if (this._kollaps[id] === false) bl.classList.add("lukket");
      });
    }
    if (["oversikt", "energi", "soner"].includes(this._fane)) this._hentHistorikk();
  }

  get _hytte() { return this._a("sensor.ki_energi_status", "hustype", "bolig") === "fritidsbolig"; }
  _l(tekst) {
    // Etiketter som betyr noe annet på hytta
    if (!this._hytte) return tekst;
    return ({ "Helgemodus": "Tom hytte (frostsikring)", "Hjemkomst": "Ankomst", "Start hjemkomst": "Start ankomst",
              "Avslutt hjemkomst": "Avslutt ankomst", "Forventet hjemkomst": "Ankomst fredag kl.", "Helgetemperatur": "Frosttemperatur",
              "Helg gulvvarme": "Frost gulvvarme", "Helg bad": "Frost bad", "Helg automatisk ved fravær": "Frostsikring når hytta er tom",
              "Torsdag/fredag etter lengre fravær": "Uansett ukedag, etter «Helg auto etter»-timer",
              "Helg senk gulvvarme": "Frost senk gulvvarme", "Alle borte": "Hytta tom" })[tekst] || tekst;
  }

  _tegnHero() {
    const sone = this._s("sensor.ki_energi_status", "ukjent");
    const forklaring = this._a("sensor.ki_energi_status", "forklaring", "Venter på motoren …");
    const skygge = this._a("sensor.ki_energi_status", "skyggemodus", false);
    const forbrukt = Number(this._a("sensor.ki_energi_status", "forbrukt_kwh", NaN));
    const grense = Number(this._a("sensor.ki_energi_status", "grense_kwh", NaN));
    const pct = isFinite(forbrukt) && isFinite(grense) && grense > 0
      ? Math.max(0, Math.min(100, (forbrukt / grense) * 100)) : 0;
    const o = 2 * Math.PI * 43;
    const ute = this._n("sensor.outdoor_meter_temperature");

    this._rot.getElementById("hero").innerHTML = `
      <div class="hero" data-sone="${esc(sone)}">
        <div class="ring" data-handling="mer" data-entity="sensor.ki_energi_status">
          <svg viewBox="0 0 100 100">
            <circle class="spor" cx="50" cy="50" r="43"></circle>
            <circle class="fyll" cx="50" cy="50" r="43"
              style="stroke-dasharray:${o};stroke-dashoffset:${o * (1 - pct / 100)}"></circle>
          </svg>
          <div class="ringtall">${Math.round(pct)}<span>%</span></div>
        </div>
        <div class="herotekst">
          <div class="heronavn">${esc(SONE_TEKST[sone] || sone)}
            ${skygge ? '<span class="merke">skygge</span>' : ""}${this._hytte ? '<span class="merke">hytte</span>' : ""}</div>
          <div class="heroforklaring">${esc(forklaring)}</div>
          <div class="herolinje">
            <span>${esc(this._s("sensor.ki_klima_status", "Klima ukjent"))}</span>
            ${isFinite(ute) ? `<span><ha-icon icon="mdi:thermometer"></ha-icon>${nf(ute, 1)}°</span>` : ""}
          </div>
        </div>
        <div class="heroknapp" data-handling="hero" title="${this._heroApen ? "Skjul" : "Slik tenker motoren"}"><ha-icon icon="${this._heroApen ? "mdi:chevron-up" : "mdi:chevron-down"}"></ha-icon></div>
        ${this._heroApen ? this._heroDetaljer() : ""}
      </div>`;
  }

  // Hurtigknapper: «leggetid» per soverom. Sover-profiler først, så resten.
  _leggetidBlokk() {
    const laster = (this._a("sensor.ki_laster", "laster", []) || []).filter((l) => l.profil === "sebastian" || l.profil === "cybele");
    if (!laster.length) return "";
    const sortert = [...laster].sort((x, y) => String(x.navn).localeCompare(String(y.navn)));
    const aktive = sortert.filter((l) => l.leggetid);
    return `
      <div class="blokk">
        <div class="hode"><span>Leggetid${this._hj("leggetid")}</span><span class="sub">${aktive.length ? aktive.map((l) => esc(l.navn)).join(", ") + " senket" : "Trykk når noen legger seg"}</span></div>
        ${this._hjTekst("leggetid")}
        <div class="hurtig">
          ${sortert.map((l) => `<div class="mini ${l.leggetid ? "aktiv" : ""}" data-handling="leggetid" data-key="${esc(l.key)}" data-avbryt="${l.leggetid ? 1 : 0}">
            <ha-icon icon="${l.leggetid ? "mdi:weather-sunny" : "mdi:bed"}"></ha-icon>${esc(l.navn)}${l.leggetid ? " · avbryt" : ""}</div>`).join("")}
        </div>
      </div>`;
  }

  _heroDetaljer() {
    const a = (n, d) => this._a("sensor.ki_energi_status", n, d);
    const tanker = a("tankegang", []) || [];
    const laster = this._a("sensor.ki_laster", "laster", []) || [];
    const senket = laster.filter((l) => l.handling === "senket");
    const ov = laster.filter((l) => l.overstyrt);
    const moduser = [
      ["input_boolean.ki_helgemodus", "Helg"], ["input_boolean.ki_sommermodus", "Sommer"],
      ["input_boolean.ki_hjemkomst_aktiv", "Hjemkomst"], ["input_boolean.ki_skyggemodus", "Skygge"],
      ["binary_sensor.ki_alle_borte", "Alle borte"], ["input_boolean.ki_sebastian_ferie", "Ferie"],
    ].filter(([id]) => this._pa(id)).map(([, n]) => n);
    const prog = (n) => nf(Number(this._a("sensor.ki_prognose", n, NaN)), 1);
    const vvb = this._s("sensor.ki_bereder", "–");
    const gard = this._st("sensor.ki_gardiner");
    const hank = this._s("sensor.ki_hanklevarmer", "");
    const min = Number(a("minutter_igjen", NaN));
    return `
      <div class="herodetaljer">
        <div class="undertittel">Slik tenker motoren nå</div>
        ${tanker.length ? tanker.map((t) => `<div class="tanke">${esc(t)}</div>`).join("")
          : `<div class="tanke">${esc(a("forklaring", "Venter på motoren …"))}</div>`}
        <div class="undertittel" style="padding-top:12px">Sammendrag</div>
        <div class="fakta">
          <span><ha-icon icon="mdi:timer-sand"></ha-icon>${isFinite(min) ? min + " min igjen av timen" : "–"}</span>
          <span><ha-icon icon="mdi:flash"></ha-icon>${nf(Number(a("forbrukt_kwh", NaN)), 2)} / ${nf(Number(a("grense_kwh", NaN)), 2)} kWh</span>
          <span><ha-icon icon="mdi:chart-timeline-variant"></ha-icon>${prog("om_15_min_kw")} → ${prog("om_60_min_kw")} kW</span>
          <span><ha-icon icon="mdi:home-thermometer"></ha-icon>${senket.length ? senket.length + " sone" + (senket.length > 1 ? "r" : "") + " senket" : "ingen senket"}</span>
          ${laster.filter((l) => l.handling === "vindu").map((l) => `<span class="badge b-feil"><ha-icon icon="mdi:window-open-variant"></ha-icon>${esc(l.navn)}: ${esc(l.vindu_navn || "vindu åpent")}</span>`).join("")}
          ${ov.length ? `<span><ha-icon icon="mdi:hand-back-right"></ha-icon>${ov.length} overstyrt</span>` : ""}
          <span><ha-icon icon="mdi:water-boiler"></ha-icon>${esc(vvb)}</span>
          ${hank ? `<span><ha-icon icon="mdi:radiator"></ha-icon>Håndklevarmer ${hank === "pa" ? "på" : "av"}</span>` : ""}
          ${gard && gard.state !== "ikke_konfigurert" ? `<span><ha-icon icon="mdi:curtains"></ha-icon>Gardiner ${esc(gard.state === "av" ? "manuelt" : gard.state)}</span>` : ""}
          ${moduser.length ? `<span><ha-icon icon="mdi:tune-variant"></ha-icon>${moduser.join(" · ")}</span>` : ""}
        </div>
        ${senket.length ? `<div class="fakta" style="padding-top:2px">${senket.map((l) => `<span class="badge b-advarsel">${esc(l.navn)} ${l.settpunkt != null ? nf(l.settpunkt, 1) + "°" : ""}</span>`).join("")}</div>` : ""}
      </div>`;
  }

  /* ---------------------------- Oversikt ---------------------- */

  _oversikt() {
    const a = (n, d) => this._a("sensor.ki_energi_status", n, d);
    const modus = [
      ["input_boolean.ki_helgemodus", this._l("Helgemodus"), "mdi:bag-suitcase", true],
      ["input_boolean.ki_sommermodus", "Sommermodus", "mdi:white-balance-sunny", true],
      ["input_boolean.ki_hjemkomst_aktiv", this._l("Hjemkomst"), "mdi:home-import-outline", true],
      ["input_boolean.ki_sebastian_ferie", "Ferie", "mdi:school-outline", true],
      ["binary_sensor.ki_alle_borte", "Alle borte", "mdi:home-export-outline", false],
    ];
    const prog = (n) => nf(Number(this._a("sensor.ki_prognose", n, NaN)), 1);
    const progTekst = this._a("sensor.ki_prognose", "forklaring", "");
    const senkede = (this._a("sensor.ki_laster", "laster", []) || [])
      .filter((l) => l.handling === "senket");

    return `
      ${this._overtakelse(true)}
      ${this._leggetidBlokk()}
      ${this._budsjettBlokk(a)}
      <div class="blokk">
        <div class="hode"><span>Forventet effekt</span><span class="sub">Uregulert + varmtvann + planlagt varme</span></div>
        <div class="tallrad fire">
          <div class="tall"><b>${prog("om_15_min_kw")}</b><span>kW om 15 min</span></div>
          <div class="tall"><b>${prog("om_30_min_kw")}</b><span>kW om 30 min</span></div>
          <div class="tall"><b>${prog("om_60_min_kw")}</b><span>kW om 1 t</span></div>
          <div class="tall"><b>${prog("om_120_min_kw")}</b><span>kW om 2 t</span></div>
        </div>
        ${progTekst ? `<div class="notat">${esc(progTekst)}</div>` : ""}
      </div>
      <div class="blokk">
        <div class="hode"><span>Siste 12 timer</span><span class="sub">Forbruk per time mot grensen</span></div>
        <div id="graf-time" class="graf">${this._grafPlassholder()}</div>
      </div>
      <div class="blokk">
        <div class="hode"><span>Modus</span></div>
        <div class="rutenett">${modus.map(([id, navn, ikon, kanSlas]) => {
          const på = this._pa(id);
          return `<div class="chip ${på ? "pa" : ""} ${this._st(id) ? "" : "mangler"}"
            data-handling="${kanSlas ? "veksle" : "mer"}" data-entity="${id}">
            <div class="chipikon"><ha-icon icon="${ikon}"></ha-icon></div>
            <div><div class="chipnavn">${navn}</div><div class="chipsub">${på ? "På" : "Av"}</div></div>
          </div>`;
        }).join("")}</div>
      </div>
      ${senkede.length ? `
      <div class="blokk">
        <div class="hode"><span>Tiltak akkurat nå</span><span class="sub">${senkede.length} sone(r) senket</span></div>
        ${senkede.map((l) => `<div class="rad rad-les">
          <div class="prikk p-advarsel"></div>
          <div class="radtekst"><div class="radnavn">${esc(l.navn)}</div>
            <div class="radsub">${esc(l.forklaring || "")}</div></div>
          <div class="radverdi">${nf(l.settpunkt, 1)}°</div></div>`).join("")}
      </div>` : ""}
      ${this._vvbKort(true)}`;
  }

  _overtakelse(kompakt) {
    const skygge = this._pa("input_boolean.ki_skyggemodus");
    const motorPa = this._pa("input_boolean.ki_energi_hovedbryter");
    const styrer = motorPa && !skygge;
    const klar = this._s("sensor.ki_overgang_klar", "ukjent");
    const hindringer = this._a("sensor.ki_overgang_klar", "hindringer", []) || [];
    const finnes = !!this._st("input_boolean.ki_skyggemodus");
    const klasse = klar === "Klar" ? "ok" : klar === "Lærer fortsatt" ? "advarsel" : "feil";
    const modus = this._a("sensor.ki_energi_status", "modus", this._s("sensor.ki_klima_status", ""));

    return `
      <div class="blokk">
        <div class="hode"><span>Hvem styrer ovnene</span>
          <span class="sub">${styrer ? "Energimotoren" : skygge ? "Skyggemodus" : "Av"} · ${esc(modus)}</span></div>
        <div class="rad">
          <div class="prikk p-${styrer ? "ok" : "noytral"}"></div>
          <div class="radtekst">
            <div class="radnavn">Motoren styrer ovnene${finnes ? "" : ' <span class="merke">mangler</span>'}${this._hj("overtakelse")}</div>
            <div class="radsub">${styrer
              ? "Skriver settpunkt til alle soner som står på «KI styrer»."
              : "Regner og logger, men rører ingen ovner. Slå av skyggemodus for å la den styre."}</div>
          </div>
          <div class="bryter ${styrer ? "on" : ""} ${finnes ? "" : "mangler"}"
               data-handling="veksle" data-entity="input_boolean.ki_skyggemodus"><span></span></div>
        </div>
        ${this._hjTekst("overtakelse")}
        ${!kompakt || !styrer ? `
        <div class="rad rad-les" data-handling="mer" data-entity="sensor.ki_overgang_klar">
          <div class="prikk p-${klasse}"></div>
          <div class="radtekst"><div class="radnavn">Beredskap: ${esc(klar)}${this._hj("beredskap")}</div>
            <div class="radsub">${hindringer.length
              ? hindringer.length + " ting å være klar over"
              : "Ingenting i veien"}</div></div>
        </div>
        ${this._hjTekst("beredskap")}` : ""}
        ${hindringer.length && !kompakt ? `<ul class="tiltak">${
          hindringer.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
        ${!motorPa ? `<div class="varsel">Energimotoren er slått av under Oppsett. Ingenting styres.</div>` : ""}
      </div>`;
  }

  _budsjettBlokk(a) {
    const igjen = Number(a("igjen_kwh", NaN));
    const tillatt = Number(a("tillatt_effekt_kw", NaN));
    const forventet = Number(a("forventet_effekt_kw", NaN));
    const min = a("minutter_igjen", "–");
    const uregulert = Number(a("uregulert_kw", NaN));
    const vvb = Number(a("vvb_reservert_kw", NaN));
    const ledig = Number(a("ledig_kw", NaN));
    const kilde = a("malekilde", "");
    const bredde = isFinite(forventet) && isFinite(tillatt) && tillatt > 0
      ? Math.max(0, Math.min(100, (forventet / tillatt) * 100)) : 0;
    return `
      <div class="blokk">
        <div class="hode"><span>Timebudsjett${this._hj("tillatt_effekt")}</span><span class="sub">${min} min igjen${kilde ? " · " + esc(kilde) : ""}</span></div>
        ${this._hjTekst("tillatt_effekt")}
        <div class="tallrad">
          <div class="tall"><b>${nf(igjen, 2)}</b><span>kWh igjen</span></div>
          <div class="tall"><b>${nf(tillatt, 2)}</b><span>kW tillatt</span></div>
          <div class="tall"><b>${nf(forventet, 2)}</b><span>kW forventet</span></div>
        </div>
        <div class="spor2"><div class="fyll2" style="width:${bredde}%"></div></div>
        <div class="under">
          <span>Uregulert ${nf(uregulert, 2)} kW${this._hj("uregulert")} · varmtvann ${nf(vvb, 2)} kW</span>
          <span>${isFinite(ledig) ? nf(ledig, 2) + " kW ledig" : ""}</span>
        </div>
        ${this._hjTekst("uregulert")}
        ${this._a("sensor.ki_energi_status", "tak_aktivt", false)
          ? `<div class="notat">Regnestykket ga høyere tillatt effekt enn timegrensen,
             fordi det er få minutter igjen av timen. Verdien er derfor kuttet ned til
             grensen — ovnene rekker ikke å nyttiggjøre seg en kortvarig topp uten at
             varmen renner over i neste time.</div>` : ""}
      </div>`;
  }

  /* ---------------------------- Soner ------------------------- */

  _soner() {
    const laster = (this._a("sensor.ki_laster", "laster", []) || []).filter((l) => l.type !== "bryter");
    if (!laster.length) return `<div class="blokk"><div class="notat">Motoren har ikke rapportert soner ennå.</div></div>`;

    return `<div class="blokk">
      <div class="hode"><span>Soner</span><span class="sub">Trykk for settpunkt og overstyring</span></div>
      ${laster.map((l) => {
        const h = HANDLING[l.handling] || { tekst: l.handling, k: "noytral" };
        const apen = this._apne.has(l.key);
        const styr = l.styr || (SONE_STYR[l.key] ? `input_boolean.${SONE_STYR[l.key]}` : null);
        const på = styr ? this._pa(styr) : false;
        const felt = (l.helpere && l.helpere.length) ? l.helpere : (SONE_HELPERE[l.key] || []);
        const ovVerdi = this._ov[l.key] !== undefined ? this._ov[l.key] : (l.mal ?? 21);
        return `
        <div class="sone ${apen ? "apen" : ""}">
          <div class="sonehode" data-handling="apne" data-key="${esc(l.key)}">
            <div class="prikk p-${h.k}"></div>
            <div class="radtekst">
              <div class="radnavn">${esc(l.navn)}${l.overstyrt ? ' <span class="merke">manuell</span>' : ""}</div>
              <div class="radsub">${esc(l.forklaring || "")}</div>
            </div>
            <div class="sonetemp">
              <b>${l.naa !== null && l.naa !== undefined ? nf(l.naa, 1) + "°" : "–"}</b>
              <span>mål ${l.settpunkt ?? l.mal ?? "–"}°</span>
            </div>
          </div>
          <div class="sonekropp">
            <div class="fakta">
              <span class="badge b-${h.k}">${esc(h.tekst)}</span>
              <span>Prioritet ${l.prio}</span><span>${esc(l.type)}</span>
              <span>plan ${nf(l.effekt, 2)} kW</span>
            </div>
            ${apen ? this._soneDetaljer(l) : ""}
            ${styr ? `<div class="rad">
              <div class="radtekst"><div class="radnavn">KI styrer sonen</div>
                <div class="radsub">Av = motoren rører den ikke</div></div>
              <div class="bryter ${på ? "on" : ""}" data-handling="veksle" data-entity="${styr}"><span></span></div>
            </div>` : ""}
            ${felt.map(([n, navn]) => this._stepperRad(`input_number.${n}`, navn, 1, " °C")).join("")}
            <div class="ovblokk">
              <div class="undertittel">Overstyr midlertidig</div>
              <div class="ovrad">
                <div class="steg" data-handling="ov" data-key="${esc(l.key)}" data-dir="-1">−</div>
                <div class="ovverdi">${nf(ovVerdi, 1)}</div>
                <div class="steg" data-handling="ov" data-key="${esc(l.key)}" data-dir="1">+</div>
                <div class="knapp" data-handling="ovsett" data-key="${esc(l.key)}" data-min="120">2 t</div>
                <div class="knapp" data-handling="ovsett" data-key="${esc(l.key)}" data-min="360">6 t</div>
                ${l.overstyrt ? `<div class="knapp rod" data-handling="ovfjern" data-key="${esc(l.key)}">Fjern</div>` : ""}
              </div>
            </div>
          </div>
        </div>`;
      }).join("")}
    </div>`;
  }

  // Live effekt/temperatur for sonen, og en liten historikkgraf i en underseksjon.
  _soneDetaljer(l) {
    const ents = l.entiteter || [];
    const eff = ents.filter((e) => e.startsWith("sensor.") && /power|effekt|_w$/i.test(e));
    const clim = ents.filter((e) => e.startsWith("climate."));
    const tempEnt = ents.find((e) => e.startsWith("sensor.") && /temp/i.test(e)) || null;
    const effW = eff.reduce((s, e) => { const v = this._n(e); return isFinite(v) ? s + v : s; }, 0);
    const temp = tempEnt ? this._n(tempEnt) : (clim.length ? Number(this._a(clim[0], "current_temperature", NaN)) : NaN);
    const sett = clim.length ? Number(this._a(clim[0], "temperature", NaN)) : NaN;
    const id = "sone:" + l.key;
    this._soneGrafer = this._soneGrafer || {};
    this._soneGrafer[l.key] = { eff, temp: tempEnt || clim[0] || null };
    return `
      <div class="tallrad" style="margin:6px 0 8px">
        <div class="tall"><b>${eff.length ? nf(effW, 0) : "–"}</b><span>W nå${eff.length > 1 ? " (" + eff.length + " ovner)" : ""}</span></div>
        <div class="tall"><b>${isFinite(temp) ? nf(temp, 1) + "°" : "–"}</b><span>rom</span></div>
        <div class="tall"><b>${isFinite(sett) ? nf(sett, 1) + "°" : "–"}</b><span>settpunkt${clim.length > 1 ? " (" + clim.length + ")" : ""}</span></div>
      </div>
      ${this._sub(id, "Siste 6 timer", `<div id="graf-sone-${esc(l.key)}" class="graf">${this._grafPlassholder()}</div>
        <div class="tegnforklaring"><span><i class="l1"></i>Effekt (W)</span><span><i class="l2"></i>Temperatur (°C)</span></div>`)}`;
  }

  // Tallfelt som rullevelger (native <select>: hjul på iPhone/Android, nedtrekk på desktop).
  _stepperRad(entity, navn, dec, enhet) {
    const st = this._st(entity);
    const a = st ? st.attributes : {};
    const steg = Number(a.step ?? (dec === 0 ? 1 : dec === 1 ? 0.5 : 0.05));
    const min = Number(a.min ?? 0), maks = Number(a.max ?? 100);
    const naa = st ? Number(st.state) : NaN;
    const desimaler = Math.max(dec, steg < 1 ? String(steg).split(".")[1]?.length || 0 : 0);
    const valg = [];
    const antall = Math.min(2000, Math.round((maks - min) / steg));
    let harNaa = false;
    for (let i = 0; i <= antall; i++) {
      const v = Number((min + i * steg).toFixed(6));
      if (isFinite(naa) && Math.abs(v - naa) < steg / 2) harNaa = true;
      valg.push(`<option value="${v}" ${isFinite(naa) && Math.abs(v - naa) < steg / 2 ? "selected" : ""}>${nf(v, desimaler)}${enhet}</option>`);
    }
    if (isFinite(naa) && !harNaa) valg.unshift(`<option value="${naa}" selected>${nf(naa, desimaler)}${enhet}</option>`);
    return `<div class="rad kompakt">
      <div class="radtekst"><div class="radnavn">${esc(navn)}</div></div>
      <select class="velger ${st ? "" : "mangler"}" data-entity="${entity}">${valg.join("")}</select>
    </div>`;
  }

  // Klokkeslett med av/på-bryter i samme rad.
  _tidBryterRad(tidEntity, bryterEntity, navn) {
    const st = this._st(tidEntity);
    const pa = this._pa(bryterEntity);
    return `<div class="rad">
      <div class="radtekst"><div class="radnavn">${esc(navn)}</div></div>
      <input class="tid ${pa ? "" : "dempet"}" type="time" data-entity="${tidEntity}" value="${st ? String(st.state).slice(0, 5) : ""}">
      <div class="bryter ${pa ? "on" : ""}" data-handling="veksle" data-entity="${bryterEntity}"><span></span></div>
    </div>`;
  }

  // To klokkeslett i én kompakt rad: «Dag 06:30 · Natt 22:30».
  _tidPar(navnA, idA, navnB, idB) {
    const v = (id) => { const st = this._st(id); return st ? String(st.state).slice(0, 5) : ""; };
    return `<div class="rad tidpar">
      <label><span>${esc(navnA)}</span><input class="tid" type="time" data-entity="${idA}" value="${v(idA)}"></label>
      <label><span>${esc(navnB)}</span><input class="tid" type="time" data-entity="${idB}" value="${v(idB)}"></label>
    </div>`;
  }

  _tidKort(id) { const st = this._st(id); return st ? String(st.state).slice(0, 5) : "–"; }

  _tidRad(entity, navn) {
    const st = this._st(entity);
    return `<div class="rad">
      <div class="radtekst"><div class="radnavn">${esc(navn)}</div></div>
      <input class="tid" type="time" data-entity="${entity}" value="${st ? String(st.state).slice(0, 5) : ""}">
    </div>`;
  }

  /* ---------------------------- Energi ------------------------ */

  _energi() {
    const grunn = this._a("sensor.ki_energi_status", "grense_grunn", "");
    const grense = Number(this._a("sensor.ki_energi_status", "grense_kwh", NaN));
    const N = (k, d) => this._a("sensor.ki_nettleie", k, d);
    const kr = (v) => (v == null ? "ukjent" : nf(v, 0) + " kr");
    const datoKort = (d) => (d ? d.slice(8, 10) + "." + d.slice(5, 7) + "." : "ukjent dato");
    const toppRad = (t) => `<div class="rad rad-les">
        <div class="prikk p-${t.prognose ? "advarsel" : t.kilde === "ekstern" ? "noytral" : "ok"}"></div>
        <div class="radtekst"><div class="radnavn">${datoKort(t.dato)}${t.prognose ? ' <span class="merke">prognose</span>' : ""}${t.kilde === "ekstern" ? ' <span class="merke">ekstern</span>' : ""}</div>
          <div class="radsub">${t.time ? "kl. " + t.time + ":00 · " : ""}${esc(t.kvalitet || "")}</div></div>
        <div class="radverdi kort">${nf(t.kwh, 2)} kWh</div></div>`;
    const kv = N("datakvalitet", "");
    const kvK = kv === "god" ? "ok" : kv === "delvis" ? "advarsel" : "feil";
    const nettleie = this._st("sensor.ki_nettleie") ? `
      <div class="blokk">
        <div class="hode"><span>Dynamisk grense${this._hj("dynamisk_grense")}</span>
          <span class="sub">${kr(N("registrert_trinn_kr", null))}/mnd${N("registrert_trinn_til", null) ? " · neste trinn ved " + nf(N("registrert_trinn_til"), 0) + " kW" : ""}</span></div>
        ${this._hjTekst("dynamisk_grense")}
        <div class="stor">${nf(grense, 2)} <small>kWh denne timen</small></div>
        <div class="konklusjon">${esc(N("hvorfor", grunn))}</div>
        <div class="tallrad">
          <div class="tall"><b>${N("dagens_maks_kwh", null) != null ? nf(N("dagens_maks_kwh"), 2) : "–"}</b><span>døgnmaks i dag${N("dagens_maks_time", null) ? " kl. " + N("dagens_maks_time") : ""}</span></div>
          <div class="tall"><b>${N("registrert_snitt", null) != null ? nf(N("registrert_snitt"), 2) : "–"}</b><span>snitt topp 3 (registrert)</span></div>
          <div class="tall"><b>${N("forventet_time_kwh", null) != null ? nf(N("forventet_time_kwh"), 2) : "–"}</b><span>forventet denne timen</span></div>
        </div>
        <div class="fakta" style="padding:8px 0 4px">
          <span class="badge b-${kvK}">data ${esc(kv || "–")}</span>
          <span>reserve ${nf(N("reserve_kwh", 0), 2)} kWh</span>
          <span>${N("dager_igjen", "–")} dager igjen</span>
          ${N("mal_tapt", false) ? '<span class="badge b-advarsel">mål passert</span>' : ""}
          ${N("tariff_ukjent", false) ? '<span class="badge b-feil">tariff ukjent</span>' : ""}
          ${N("tillat_dyrere_trinn", false) ? '<span class="badge b-advarsel">dyrere trinn tillatt</span>' : ""}
        </div>
        ${this._sub("energi:topp3", "Topp tre denne måneden", `
          ${this._dognGraf()}
          <div class="undertittel" style="padding-top:8px">Registrert</div>
          ${(N("topp_tre", []) || []).map(toppRad).join("") || '<div class="notat">Ingen fullførte dager ennå.</div>'}
          ${N("forventet_topp_tre", null) ? `
          <div class="undertittel" style="padding-top:10px">Hvis denne timen ender på ${nf(N("forventet_time_kwh"), 2)} kWh — prognose</div>
          ${(N("forventet_topp_tre", []) || []).map(toppRad).join("")}
          <div class="under"><span>Snitt ${nf(N("forventet_snitt", NaN), 2)} → ${kr(N("forventet_trinn_kr", null))}/mnd</span>
            <span>${N("okning_fastledd_kr", null) == null ? "økning ukjent" : N("okning_fastledd_kr") > 0 ? "+" + nf(N("okning_fastledd_kr"), 0) + " kr fastledd" : N("redusert_margin", false) ? "samme trinn, mindre rom" : N("hoyere_dognmaks", false) ? "ny døgnmaks, uendret topp 3" : "ingen endring"}</span></div>` : ""}`,
          false, `<span class="sub">${(N("topp_tre", []) || []).map((t) => nf(t.kwh, 2)).join(" / ") || "–"} kWh</span>`)}
        <div class="notat">${(N("datakvalitet_grunner", []) || []).map(esc).join(". ")}${(N("datakvalitet_grunner", []) || []).length ? ". " : ""}${(N("reserve_grunner", []) || []).map(esc).join(", ")}</div>
      </div>` : "";

    return `
      ${nettleie}
      <div class="blokk">
        <div class="hode"><span>Effekt siste 6 timer</span><span class="sub">Uregulert mot styrt</span></div>
        <div id="graf-effekt" class="graf">${this._grafPlassholder()}</div>
        <div class="tegnforklaring">
          <span><i class="l1"></i>Uregulert</span><span><i class="l2"></i>Styrt varme</span>
          <span class="live"><i class="pulser"></i>Nå ${nf(this._n("sensor.ki_uregulert_effekt") / 1000, 2)} + ${nf(this._n("sensor.ki_styrt_effekt") / 1000, 2)} kW</span>
          <span class="grafles">Dra over grafen for å lese av</span>
        </div>
      </div>
      <div class="blokk">
        <div class="hode"><span>Grenser${this._hj("shed")}${this._hj("komfortvekt")}</span></div>
        ${this._stepperRad("input_number.ki_maks_time_kwh", "Absolutt timegrense", 2, " kWh")}
        ${this._stepperRad("input_number.ki_mal_trinn_kw", "Ønsket trinn: snitt under", 1, " kW")}
        ${this._stepperRad("input_number.ki_reserve_topp_kwh", "Reserve mot neste trinn", 2, " kWh")}
        <div class="rad">
          <div class="radtekst"><div class="radnavn">Tillat dyrere trinn</div>
            <div class="radsub">På = komfort foran fastledd; bare den absolutte grensen gjelder</div></div>
          <div class="bryter ${this._pa("input_boolean.ki_tillat_dyrere_trinn") ? "on" : ""}" data-handling="veksle" data-entity="input_boolean.ki_tillat_dyrere_trinn"><span></span></div>
        </div>
        ${this._stepperRad("input_number.ki_min_time_kwh", "Laveste timegrense", 1, " kWh")}
        ${this._stepperRad("input_number.ki_reserve_uregulert_kwh", "Reserve uregulert", 2, " kWh")}
        ${this._stepperRad("input_number.ki_shed_gulv_maks", "Maks senking gulvvarme", 1, " °C")}
        ${this._stepperRad("input_number.ki_shed_panel_maks", "Maks senking panelovn", 1, " °C")}
        ${this._stepperRad("input_number.ki_komfort_vekt", "Komfortvekt", 0, "")}
        ${this._hjTekst("komfortvekt")}
        ${this._hjTekst("shed")}
      </div>
      <div class="blokk">
        <div class="hode"><span>Denne måneden</span><span class="sub">Estimat, ikke måling</span></div>
        <div class="tallrad">
          <div class="tall"><b>${nf(this._n("input_number.ki_stat_unngatte_topper"), 0)}</b><span>unngåtte topper</span></div>
          <div class="tall"><b>${nf(this._n("input_number.ki_stat_shed_hendelser"), 0)}</b><span>utkoblinger</span></div>
          <div class="tall"><b>${nf(this._n("input_number.ki_stat_flyttet_kwh"), 2)}</b><span>kWh flyttet</span></div>
        </div>
        <div class="tallrad" style="margin-top:8px">
          <div class="tall"><b>${nf(this._n("sensor.ki_besparelse"), 0)}</b><span>kr spart (est.)</span></div>
          <div class="tall"><b>${nf(this._a("sensor.ki_besparelse", "spart_nettleie_kr", NaN), 0)}</b><span>kr nettleie</span></div>
          <div class="tall"><b>${nf(this._n("input_number.ki_stat_komfortavvik"), 1)}</b><span>°C·t komfortavvik</span></div>
        </div>
        <div class="under"><span>Neste trinn koster ${nf(this._a("sensor.ki_besparelse", "trinn_diff_kr", NaN), 0)} kr/mnd mer (fra tarifftabellen)</span></div>
        <div class="notat">${esc(this._a("sensor.ki_besparelse", "merknad", "Uten kontrollgruppe er «uten KI-styring» alltid et estimat."))}</div>
      </div>`;
  }

  /* ---------------------------- Varmtvann --------------------- */

  _varmtvann() {
    const u = this._underfane || "bereder";
    const faner = [["bereder", "Bereder", "mdi:water-boiler"], ["handkle", "Håndklevarmer", "mdi:radiator"]];
    return `<div class="underfaner">${faner.map(([id, navn, ikon]) => `
        <div class="underfane ${u === id ? "aktiv" : ""}" data-handling="underfane" data-id="${id}">
          <ha-icon icon="${ikon}"></ha-icon><span>${navn}</span></div>`).join("")}</div>`
      + (u === "handkle" ? this._handkleKort() : this._vvbKort(false));
  }

  _dato(iso) {
    if (!iso) return "–";
    const d = new Date(iso);
    if (isNaN(d)) return "–";
    const dag = ["søn", "man", "tir", "ons", "tor", "fre", "lør"][d.getDay()];
    const mnd = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"][d.getMonth()];
    const kl = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const i_dag = new Date(); const diff = Math.round((d - new Date(i_dag.getFullYear(), i_dag.getMonth(), i_dag.getDate())) / 86400000);
    const naar = diff === 0 ? "i dag" : diff === 1 ? "i morgen" : diff === -1 ? "i går" : `${dag} ${d.getDate()}. ${mnd}`;
    return `${naar} kl. ${kl}`;
  }

  _gardinKort() {
    const st = this._st("sensor.ki_gardiner");
    const a = (k, d) => this._a("sensor.ki_gardiner", k, d);
    const styr = this._pa("input_boolean.ki_styr_gardiner");
    const tilstand = st ? st.state : "ukjent";
    const klasse = !styr ? "noytral" : tilstand === "lukket" ? "advarsel" : tilstand === "apen" ? "ok" : "noytral";
    const navn = tilstand === "ikke_konfigurert" ? "Ingen gardin valgt" : !styr ? "KI-styring av"
      : tilstand === "lukket" ? "Lukket" : tilstand === "apen" ? "Åpen" : "Ingen styring nå";
    return `
      <div class="blokk">
        <div class="hode"><span>Gardiner stue${this._hj("gardiner")}</span>
          <span class="sub">${a("i_sesong", false) ? "Sesong " + esc(a("sesong", "")) : "Utenfor sesong"}</span></div>
        ${this._hjTekst("gardiner")}
        <div class="rad rad-les" data-handling="mer" data-entity="${esc(a("cover", "sensor.ki_gardiner") || "sensor.ki_gardiner")}">
          <div class="prikk p-${klasse}"></div>
          <div class="radtekst"><div class="radnavn">${navn}</div>
            <div class="radsub">${esc(a("forklaring", "–"))}${a("neste", "") ? " · " + esc(a("neste", "")) : ""}</div></div>
          <div class="radverdi">${esc(a("faktisk", "") || "")}</div>
        </div>
        <div class="rad">
          <div class="radtekst"><div class="radnavn">KI styrer gardinene</div>
            <div class="radsub">Lukkes når sola er nede i fyringssesongen, skjermer mot sol om sommeren</div></div>
          <div class="bryter ${styr ? "on" : ""} ${this._st("input_boolean.ki_styr_gardiner") ? "" : "mangler"}"
               data-handling="veksle" data-entity="input_boolean.ki_styr_gardiner"><span></span></div>
        </div>
        <div class="rad">
          <div class="radtekst"><div class="radnavn">Følg sola</div>
            <div class="radsub">På = åpnes først når sola er oppe. Av = bare klokkeslettene under.</div></div>
          <div class="bryter ${this._pa("input_boolean.ki_gardin_folg_sol") ? "on" : ""}"
               data-handling="veksle" data-entity="input_boolean.ki_gardin_folg_sol"><span></span></div>
        </div>
        <div class="undertittel" style="padding-top:10px">Klokkeslett</div>
        ${this._tidRad("input_datetime.ki_gardin_apne_tidligst", "Åpne tidligst")}
        ${this._tidRad("input_datetime.ki_gardin_lukk_senest", "Lukk senest")}
        <div class="undertittel" style="padding-top:10px">Sesong</div>
        ${this._manedStripe("input_number.ki_gardin_start_maned", "input_number.ki_gardin_slutt_maned", "Gardinsesong")}
        ${this._dognplan([{ navn: "Gardiner", spenn: [["input_datetime.ki_gardin_apne_tidligst", "input_datetime.ki_gardin_lukk_senest", "dag", "Kan være åpne"]] }])}
        ${this._stepperRad("input_number.ki_gardin_start_maned", "Fra måned", 0, "")}
        ${this._stepperRad("input_number.ki_gardin_slutt_maned", "Til og med måned", 0, "")}
        ${this._stepperRad("input_number.ki_gardin_ute_grense", "Hold lukket på dagen under", 0, " °C")}
        <div class="notat">Utenfor sesongen styres gardinene bare i sommermodus (solskjerming når sola står høyt og det er over 22 °C).</div>
      </div>`;
  }

  _handkleKort() {
    const a = (k, d) => this._a("sensor.ki_hanklevarmer", k, d);
    const konfigurert = !!a("bryter", "");
    const ent = a("bryter", "switch.hanklevarmer");
    const styr = this._pa("input_boolean.ki_styr_hanklevarmer");
    const pa = this._s("sensor.ki_hanklevarmer", "av") === "pa";
    const effekt = Number(a("effekt_w", NaN));
    const maks = Number(a("maks_min", this._n("input_number.ki_hanklevarmer_maks_pa_tid")));
    const minutter = Number(a("minutter_pa", 0));
    const naerMaks = pa && isFinite(maks) && minutter > maks * 0.8;
    const iVindu = !!a("i_vindu", false);

    return `
      <div class="blokk">
        <div class="hode"><span>Håndklevarmer${this._hj("handkle")}</span>
          <span class="sub">${!konfigurert ? "Ikke satt opp" : pa ? "På" + (minutter ? " i " + minutter + " min" : "") : "Av"}</span></div>
        ${this._hjTekst("handkle")}
        <div class="rad rad-les" data-handling="mer" data-entity="${esc(ent)}">
          <div class="prikk p-${naerMaks ? "advarsel" : pa ? "ok" : "noytral"}"></div>
          <div class="radtekst">
            <div class="radnavn">${!konfigurert ? "Ingen håndklevarmer valgt" : pa ? "Varmer nå" : "Står av"}</div>
            <div class="radsub">${esc(a("forklaring", "Velg bryter under Konfigurer → Utstyr"))}</div>
          </div>
          <div class="radverdi">${isFinite(effekt) ? nf(effekt, 0) + " W" : "–"}</div>
        </div>
        <div class="rad">
          <div class="radtekst"><div class="radnavn">Bryteren nå</div>
            <div class="radsub">${styr ? (iVindu ? "I dusjvindu — styres av KI" : "Manuell bruk slås av etter maks på-tid") : "Slås på igjen automatisk"}</div></div>
          <div class="bryter ${pa ? "on" : ""} ${konfigurert ? "" : "mangler"}"
               data-handling="bryter" data-entity="${esc(ent)}"><span></span></div>
        </div>
        <div class="rad">
          <div class="radtekst"><div class="radnavn">KI styrer håndklevarmeren</div>
            <div class="radsub">Av = står på konstant</div></div>
          <div class="bryter ${styr ? "on" : ""} ${this._st("input_boolean.ki_styr_hanklevarmer") ? "" : "mangler"}"
               data-handling="veksle" data-entity="input_boolean.ki_styr_hanklevarmer"><span></span></div>
        </div>
        ${naerMaks ? `<div class="varsel">Har stått på i ${minutter} minutter.
          Sikkerhetsavstengingen slår inn ved ${nf(maks, 0)} minutter.</div>` : ""}
      </div>
      <div class="blokk">
        <div class="hode"><span>Dusjvinduer</span><span class="sub">${esc(a("morgen", ""))} · ${esc(a("kveld", ""))}</span></div>
        ${this._dognplan([
          { navn: "Håndklevarmer", spenn: [["input_datetime.ki_hanklevarmer_morgen_start", "input_datetime.ki_hanklevarmer_morgen_slutt", "ok", "Morgen"],
                                          ["input_datetime.ki_hanklevarmer_kveld_start", "input_datetime.ki_hanklevarmer_kveld_slutt", "ok", "Kveld"]] },
        ])}
        <div class="undertittel">Morgen</div>
        ${this._tidRad("input_datetime.ki_hanklevarmer_morgen_start", "Fra")}
        ${this._tidRad("input_datetime.ki_hanklevarmer_morgen_slutt", "Til")}
        <div class="undertittel" style="padding-top:10px">Kveld</div>
        ${this._tidRad("input_datetime.ki_hanklevarmer_kveld_start", "Fra")}
        ${this._tidRad("input_datetime.ki_hanklevarmer_kveld_slutt", "Til")}
        <div class="undertittel" style="padding-top:10px">Sikkerhet</div>
        ${this._stepperRad("input_number.ki_hanklevarmer_maks_pa_tid", "Slå av etter", 0, " min")}
        <div class="notat">Utenfor vinduene kan den slås på manuelt; da slås den av igjen etter maks på-tid. I rød effektsone utsettes starten noen minutter.</div>
      </div>`;
  }

  // Søylediagram: døgnmaks per dato denne måneden, topp tre uthevet, mål og grense som linjer.
  _dognGraf() {
    const N = (k, d) => this._a("sensor.ki_nettleie", k, d);
    const dager = N("dogn_maned", []) || [];
    const eksterne = (N("topp_tre", []) || []).filter((t) => t.kilde === "ekstern");
    const iDag = new Date();
    const antall = new Date(iDag.getFullYear(), iDag.getMonth() + 1, 0).getDate();
    const perDag = {};
    dager.forEach((d) => { perDag[Number(d.dato.slice(8, 10))] = d; });
    const mal = Number(N("mal_kw", NaN)), hard = Number(N("hard_kwh", NaN)), grense = Number(N("grense_kwh", NaN));
    const verdier = dager.map((d) => d.kwh).concat(eksterne.map((t) => t.kwh)).filter(isFinite);
    const maks = Math.max(1, ...verdier, isFinite(hard) ? hard : 0, isFinite(mal) ? mal : 0) * 1.08;
    const hoyde = (v) => (100 * v / maks).toFixed(1);
    if (!dager.length && !eksterne.length) return '<div class="notat">Grafen fylles etter hvert som dager fullføres.</div>';
    return `<div class="dogngraf">
      ${isFinite(mal) ? `<div class="dg-linje mal" style="bottom:${hoyde(mal)}%"><span>mål ${nf(mal, 1)}</span></div>` : ""}
      ${isFinite(grense) ? `<div class="dg-linje grense" style="bottom:${hoyde(grense)}%"><span>grense ${nf(grense, 2)}</span></div>` : ""}
      <div class="dg-soyler">
        ${eksterne.map((t) => `<div class="dg-dag ekstern" title="ekstern, ukjent dato: ${nf(t.kwh, 2)} kWh">
            <div class="dg-soyle" style="height:${hoyde(t.kwh)}%"></div><span>?</span></div>`).join("")}
        ${Array.from({ length: antall }, (_, i) => i + 1).map((dag) => {
          const d = perDag[dag];
          const k = !d ? "" : d.topp ? "topp" : d.kvalitet === "estimert" ? "est" : "";
          const erIDag = dag === iDag.getDate();
          return `<div class="dg-dag ${k} ${erIDag ? "idag" : ""}" title="${dag}. — ${d ? nf(d.kwh, 2) + " kWh kl. " + d.time + " (" + d.kvalitet + (d.manglende_timer ? ", " + d.manglende_timer + " t mangler" : "") + ")" : "ingen data"}">
            <div class="dg-soyle" style="height:${d ? hoyde(d.kwh) : 0}%"></div>
            ${d && d.manglende_timer ? '<i class="dg-hull"></i>' : ""}
            <span>${dag % 5 === 0 || dag === 1 ? dag : ""}</span></div>`;
        }).join("")}
      </div>
    </div>
    <div class="stripeforklaring"><span><i class="s-valgt"></i>Topp tre</span><span><i class="s-pris"></i>Andre dager</span><span><i class="s-est"></i>Estimert</span><span><i class="s-ekst"></i>Ekstern (uten dato)</span><span>Ramme = i dag · prikk = timer mangler</span></div>`;
  }

  _prisStripe() {
    const d = this._a("sensor.ki_vvb_billige_timer", "doegn", []) || [];
    if (!d.length) return '<div class="notat">Ingen døgndata ennå.</div>';
    const priser = d.map((x) => x.pris).filter((p) => p != null && isFinite(p));
    const maks = priser.length ? Math.max(...priser) : 0;
    const min = priser.length ? Math.min(...priser) : 0;
    const harPris = priser.length > 0;
    const span = Math.max(maks - min, 0.01);
    return `
      <div class="stripe">
        ${d.map((x) => {
          const h = harPris && x.pris != null ? 25 + 75 * ((x.pris - min) / span) : 55;
          const kl = x.valgt ? "valgt" : x.vindu ? "vindu" : "";
          return `<div class="time ${kl} ${x.naa ? "naa" : ""}" title="${String(x.t).padStart(2, "0")}:00${x.pris != null ? " · " + nf(x.pris, 2) : ""}">
            <div class="soyle" style="height:${h.toFixed(0)}%"></div>
            <span>${x.t % 3 === 0 ? String(x.t).padStart(2, "0") : ""}</span></div>`;
        }).join("")}
      </div>
      <div class="stripeforklaring">
        <span><i class="s-valgt"></i>Berederen kjører</span>
        <span><i class="s-vindu"></i>Vindu</span>
        ${harPris ? `<span><i class="s-pris"></i>Pris ${nf(min, 2)}–${nf(maks, 2)}</span>` : "<span>Ingen prisdata</span>"}
      </div>`;
  }

  _vvbKort(kort) {
    const a = (k, d) => this._a("sensor.ki_bereder", k, d);
    const konfigurert = !!a("bryter", "");
    const status = this._s("sensor.ki_vvb_legionella_status", "ukjent");
    const dager = this._n("sensor.ki_vvb_dager_siden_siste_syklus");
    const effekt = Number(a("effekt_w", NaN));
    const bryterPa = !!a("bryter_pa", false);
    const varmer = !!a("varmer", false);
    const tvungen = this._pa("input_boolean.ki_vvb_tvungen_syklus_aktiv");
    const kritisk = this._pa("input_boolean.ki_vvb_kritisk_varslet");
    const reservert = Number(a("reservert_kw", NaN));
    const vvbGrunn = this._s("sensor.ki_vvb_forklaring", a("forklaring", ""));
    const klasse = kritisk ? "feil" : tvungen ? "advarsel" : varmer ? "ok" : "noytral";
    const bryter = a("bryter", "switch.varmtvannsbereder");

    // Legionella
    const legAktiv = a("legionella_aktiv", true);
    const sikret = !!a("sikret", false);
    const forfalt = !!a("forfalt", false);
    const hard = Number(a("hard_frist_dager", 7));
    const intervall = Number(a("intervall_dager", 3));
    const pct = isFinite(dager) && hard > 0 ? Math.max(0, Math.min(100, (dager / hard) * 100)) : 0;
    const legKlasse = !legAktiv ? "noytral" : forfalt ? "feil" : sikret ? "ok" : "advarsel";
    const legTekst = !legAktiv ? "Legionellasikring er av" : forfalt ? "Forfalt — tvinges på"
      : sikret ? "Sikret" : "Bør kjøres snart";

    const hoved = `
      <div class="blokk">
        <div class="hode"><span>Varmtvann</span><span class="sub">${esc(status)}</span></div>
        <div class="rad rad-les" data-handling="mer" data-entity="${esc(bryter)}">
          <div class="prikk p-${klasse}"></div>
          <div class="radtekst"><div class="radnavn">${!konfigurert ? "Ikke satt opp" : varmer ? "Varmer nå" : bryterPa ? "Bryter på, trekker ikke effekt" : "Står stille"}</div>
            <div class="radsub">${esc(vvbGrunn)}</div></div>
          <div class="radverdi">${isFinite(effekt) ? nf(effekt, 0) + " W" : "–"}</div>
        </div>
        <div class="rad">
          <div class="radtekst"><div class="radnavn">Bryteren nå</div>
            <div class="radsub">${bryterPa ? "På" : "Av"} · vindu ${esc(a("vindu", ""))}</div></div>
          <div class="bryter ${bryterPa ? "on" : ""} ${konfigurert ? "" : "mangler"}"
               data-handling="bryter" data-entity="${esc(bryter)}"><span></span></div>
        </div>
        ${kritisk ? `<div class="varsel">Berederen svarer ikke på tvungen start. Sjekk sikring, kontaktor og element fysisk.</div>` : ""}
        ${kort ? `<div class="rad rad-les" data-handling="fane" data-fane="varmtvann">
          <div class="prikk p-${legKlasse}"></div>
          <div class="radtekst"><div class="radnavn">Legionella: ${legTekst}</div>
            <div class="radsub">Sist sikret ${this._dato(a("siste_syklus", null))} · frist ${this._dato(a("neste_frist", null))}</div></div>
        </div>` : ""}
      </div>`;

    const leg = `
      <div class="blokk">
        <div class="hode"><span>Legionella${this._hj("vvb_syklus")}</span>
          <span class="badge b-${legKlasse}">${legTekst}</span></div>
        ${this._hjTekst("vvb_syklus")}
        <div class="bar"><div class="bar-fyll f-${legKlasse}" style="width:${pct.toFixed(0)}%"></div>
          <div class="bar-mark" style="left:${hard > 0 ? Math.min(100, (intervall / hard) * 100).toFixed(0) : 0}%"></div></div>
        <div class="bar-tekst"><span>${isFinite(dager) ? nf(dager, 1) + " d siden" : "–"}</span><span>ønsket hver ${nf(intervall, 0)} d</span><span>frist ${nf(hard, 0)} d</span></div>
        <div class="rad rad-les" data-handling="mer" data-entity="datetime.ki_vvb_siste_godkjente_syklus">
          <div class="prikk p-${sikret ? "ok" : "noytral"}"></div>
          <div class="radtekst"><div class="radnavn">Sist sikret (metning)</div>
            <div class="radsub">Termostaten koblet ut etter full oppvarming</div></div>
          <div class="radverdi brytbar">${this._dato(a("siste_syklus", null))}</div>
        </div>
        <div class="rad rad-les">
          <div class="prikk p-${forfalt ? "feil" : "noytral"}"></div>
          <div class="radtekst"><div class="radnavn">Neste frist</div>
            <div class="radsub">Etter dette tvinges berederen på uansett pris</div></div>
          <div class="radverdi brytbar">${this._dato(a("neste_frist", null))}</div>
        </div>
        <div class="tallrad" style="margin-top:8px">
          <div class="tall"><b>${nf(reservert, 2)}</b><span>kW reservert</span></div>
          <div class="tall"><b>${nf(this._n("sensor.ki_vvb_oppvarming_minutter"), 0)}</b><span>min varmet</span></div>
          <div class="tall"><b>${this._pa("binary_sensor.ki_vvb_mettet") ? "Ja" : "Nei"}</b><span>mettet nå</span></div>
        </div>
        ${this._sub("vvb:detaljer", "Metning, vindu og sikring", `
        <div class="rad rad-les" data-handling="mer" data-entity="binary_sensor.ki_vvb_mettet">
          <div class="prikk p-${this._pa("binary_sensor.ki_vvb_mettet") ? "ok"
            : this._pa("binary_sensor.ki_vvb_ingen_respons") ? "feil" : "noytral"}"></div>
          <div class="radtekst"><div class="radnavn">Metning</div>
            <div class="radsub">${this._pa("binary_sensor.ki_vvb_mettet")
              ? "Termostaten har koblet ut — vannet er på settpunkt"
              : this._pa("binary_sensor.ki_vvb_ingen_respons")
                ? "Bryteren står på uten at effekten stiger — sannsynlig feil"
                : this._pa("input_boolean.ki_vvb_har_trukket_effekt")
                  ? "Har trukket effekt denne runden, venter på utkobling"
                  : "Ingen effekt registrert denne runden"}</div></div>
        </div>
        <div class="rad rad-les" data-handling="mer" data-entity="binary_sensor.ki_vvb_i_vindu">
          <div class="prikk p-${this._pa("binary_sensor.ki_vvb_i_vindu") ? "ok" : "noytral"}"></div>
          <div class="radtekst"><div class="radnavn">Oppvarmingsvindu</div>
            <div class="radsub">${this._pa("binary_sensor.ki_vvb_ferdig_i_vinduet")
              ? "Ferdig for i natt" : this._pa("binary_sensor.ki_vvb_i_vindu")
                ? "Åpent nå" : "Lukket"}</div></div>
        </div>
        <div class="rad">
          <div class="radtekst"><div class="radnavn">Legionellasikring</div>
            <div class="radsub">Av = ingen tvungen syklus, bare vindu og pris</div></div>
          <div class="bryter ${legAktiv ? "on" : ""}"
               data-handling="veksle" data-entity="input_boolean.ki_vvb_legionella_aktiv"><span></span></div>
        </div>
        <div class="hurtig">
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi" data-tjeneste="vvb_tving_syklus">Kjør syklus nå</div>
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi" data-tjeneste="${this._pa("binary_sensor.ki_vvb_boost_aktiv") ? "vvb_avbryt_boost" : "vvb_boost"}">${this._pa("binary_sensor.ki_vvb_boost_aktiv") ? "Avbryt boost" : "Boost varmtvann"}</div>
        </div>`)}
      </div>`;

    if (kort) return hoved;
    const hovedOgLeg = hoved + leg;

    const timer = this._a("sensor.ki_vvb_billige_timer", "timer", []) || [];
    const metode = this._a("sensor.ki_vvb_billige_timer", "metode", "");
    const billigNa = this._pa("binary_sensor.ki_vvb_billig_time_na");
    const boost = this._pa("binary_sensor.ki_vvb_boost_aktiv");

    return hovedOgLeg + `
      <div class="blokk">
        <div class="hode"><span>Prisstyring${this._hj("vvb_billige")}</span><span class="sub">${billigNa ? "Billig time nå" : "Venter"}</span></div>
        ${this._hjTekst("vvb_billige")}
        <div class="konklusjon">${esc(this._s("sensor.ki_vvb_forklaring", "–"))}</div>
        ${this._prisStripe()}
        <div class="notat">${esc(metode)}${
          this._a("sensor.ki_vvb_billige_timer", "antall_kandidater", 0) > 24
            ? " Prisdata kommer i kvartersoppløsning, så flere oppføringer per time slås sammen."
            : ""}</div>
        ${this._stepperRad("input_number.vvb_billigste_timer_dogn", "Antall billige timer", 0, " t")}
        ${this._stepperRad("input_number.ki_vvb_intervall_dager", "Ønsket legionellaintervall", 0, " d")}
        ${this._stepperRad("input_number.ki_vvb_maks_dager", "Hard frist", 0, " d")}
        ${this._tidRad("input_datetime.ki_vvb_klar_innen", "Ferdig innen")}
        ${this._tidRad("input_datetime.ki_vvb_vindu_start", "Vindu starter")}
        <div class="rad">
          <div class="radtekst"><div class="radnavn">Prisstyring</div>
            <div class="radsub">Av = berederen står som den står</div></div>
          <div class="bryter ${this._pa("input_boolean.ki_vvb_prisstyring") ? "on" : ""}"
               data-handling="veksle" data-entity="input_boolean.ki_vvb_prisstyring"><span></span></div>
        </div>
        ${this._a("sensor.ki_vvb_billige_timer", "norgespris", false) ? `
        <div class="rad rad-les"><div class="prikk p-ok"></div>
          <div class="radtekst"><div class="radnavn">Norgespris aktiv</div>
            <div class="radsub">Strømprisen er lik hele døgnet. Berederen legges i vinduet med billigste nettleie (natt/helg) — spotpris trengs ikke.</div></div></div>` : `
        <div class="rad">
          <div class="radtekst"><div class="radnavn">Følg spotpris</div>
            <div class="radsub">${this._a("sensor.ki_vvb_billige_timer", "har_priser", false) ? "Velger de billigste enkelttimene fram til fristen" : "Ingen prisdata — velg spotprissensor under Konfigurer, ellers brukes vinduet"}</div></div>
          <div class="bryter ${this._pa("input_boolean.ki_vvb_folg_spotpris") ? "on" : ""}"
               data-handling="veksle" data-entity="input_boolean.ki_vvb_folg_spotpris"><span></span></div>
        </div>`}
        <div class="rad">
          <div class="radtekst"><div class="radnavn">Alltid på</div>
            <div class="radsub">Overstyrer automatikken helt</div></div>
          <div class="bryter ${this._pa("input_boolean.ki_vvb_alltid_pa") ? "on" : ""}"
               data-handling="veksle" data-entity="input_boolean.ki_vvb_alltid_pa"><span></span></div>
        </div>
      </div>
      <div class="blokk">
        <div class="hode"><span>Handling${this._hj("vvb_handling")}</span></div>
        ${this._hjTekst("vvb_handling")}
        <div class="hurtig">
          <div class="mini" data-handling="tjeneste" data-domene="script" data-tjeneste="${boost ? "ki_vvb_avbryt_boost" : "ki_vvb_boost"}">${boost ? "Avbryt boost" : "Boost nå"}</div>
          <div class="mini" data-handling="tjeneste" data-domene="script" data-tjeneste="ki_vvb_tving_syklus_na">Tving syklus nå</div>
        </div>
      </div>`;
  }

  /* ---------------------------- Tanker ------------------------ */

  _tanker() {
    const a = (n, d) => this._a("sensor.ki_energi_status", n, d);
    const laster = this._a("sensor.ki_laster", "laster", []) || [];
    const logg = this._a("sensor.ki_beslutningslogg", "linjer", []) || [];
    const tau = this._a("sensor.ki_tidskonstanter", "soner", {}) || {};

    const resonnement = [
      ["Grensen denne timen", `${nf(Number(a("grense_kwh", NaN)), 2)} kWh`, a("grense_grunn", "")],
      ["Brukt så langt", `${nf(Number(a("forbrukt_kwh", NaN)), 2)} kWh`, `Kilde: ${esc(a("malekilde", "ukjent"))}`],
      ["Tillatt snitt resten av timen", `${nf(Number(a("tillatt_effekt_kw", NaN)), 2)} kW`,
        `${a("minutter_igjen", "–")} minutter igjen`],
      ["Uregulert last nå", `${nf(Number(a("uregulert_kw", NaN)), 2)} kW`,
        `Om en time: ${nf(Number(a("uregulert_60_kw", NaN)), 2)} kW (innlært profil)`],
      ["Varmtvann", `${nf(Number(a("vvb_reservert_kw", NaN)), 2)} kW`, a("vvb_grunn", "")],
      ["Solbidrag stue", `${nf(Number(a("solfaktor", 0)), 2)}`, "0 = ingen sol, 1 = full klar sol på fasaden"],
      ["Ledig til varme", `${nf(Number(a("ledig_kw", NaN)), 2)} kW`, "Etter reserver og prioriterte laster"],
    ];

    return `
      <div class="blokk">
        <div class="hode"><span>Slik tenker motoren nå</span></div>
        <div class="konklusjon">${esc(a("forklaring", "–"))}</div>
        ${resonnement.map(([navn, verdi, sub]) => `
          <div class="rad">
            <div class="radtekst"><div class="radnavn">${esc(navn)}</div>
              <div class="radsub">${esc(sub)}</div></div>
            <div class="radverdi">${esc(verdi)}</div>
          </div>`).join("")}
      </div>
      <div class="blokk">
        <div class="hode"><span>Vurdering per sone</span><span class="sub">Sortert som motoren prioriterer</span></div>
        ${laster.map((l) => {
          const h = HANDLING[l.handling] || { tekst: l.handling, k: "noytral" };
          return `<div class="rad rad-les">
            <div class="prikk p-${h.k}"></div>
            <div class="radtekst"><div class="radnavn">${esc(l.navn)} <span class="badge b-${h.k}">${esc(h.tekst)}</span>${l.leggetid ? ' <span class="badge b-noytral">leggetid</span>' : ""}</div>
              <div class="radsub">${esc(l.forklaring || "")}</div></div>
            <div class="radverdi kort">${nf(l.effekt, 2)} kW</div></div>`;
        }).join("")}
      </div>
      ${Object.keys(tau).length ? `
      <div class="blokk">
        <div class="hode"><span>Innlærte tidskonstanter${this._hj("tidskonstant")}</span><span class="sub">Treghet · oppvarming · målinger</span></div>
        ${this._hjTekst("tidskonstant")}
        ${Object.entries(tau).map(([navn, v]) => `
          <div class="rad rad-les">
            <div class="radtekst"><div class="radnavn">${esc(navn)}</div>
              <div class="radsub">${v.malinger || 0} målinger${v.malinger < 20 ? " — lærer fortsatt" : ""}</div></div>
            <div class="radverdi">${v.tau_timer ? nf(v.tau_timer, 1) + " t" : "–"} · ${v.grader_per_time ? nf(v.grader_per_time, 1) + " °C/t" : "–"}</div>
          </div>`).join("")}
        <div class="notat">Tidskonstanten er hvor lenge rommet holder på overtemperaturen.
          Lang tidskonstant betyr at nattsenking sjelden lønner seg, fordi gjenoppvarmingen
          skjer til dyrere dagtariff.</div>
      </div>` : ""}
      <div class="blokk">
        <div class="hode"><span>Beslutningslogg</span><span class="sub">${logg.length} oppføringer</span></div>
        ${logg.length ? logg.slice(0, 30).map((l) => `
          <div class="logg">
            <div class="loggtopp">
              <span class="loggtid">${esc(String(l.tid || "").slice(11, 16))}</span>
              <span class="badge b-${l.sone === "gronn" ? "ok" : l.sone === "gul" ? "advarsel" : "feil"}">${esc(l.sone)}</span>
              ${l.skygge ? '<span class="merke">skygge</span>' : ""}
              <span class="loggtall">${nf(l.forbrukt, 2)} / ${nf(l.grense, 2)} kWh</span>
            </div>
            <div class="loggtekst">${esc(l.forklaring || "")}</div>
            ${(l.tiltak || []).length ? `<ul class="tiltak">${l.tiltak.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
          </div>`).join("") : '<div class="notat">Ingen beslutninger logget ennå. Motoren logger bare når den gjør noe, eller når det blir trangt.</div>'}
      </div>`;
  }

  /* ---------------------------- Oppsett ----------------------- */

  _oppsett() {
    const grupper = [
      ["Motor", [
        ["input_boolean.ki_energi_hovedbryter", "Energimotor", "Hovedbryter for hele integrasjonen"],
        ["input_boolean.ki_skyggemodus", "Skyggemodus", "Regner og logger, styrer ingenting", "skyggemodus"],
        ["input_boolean.ki_dynamisk_grense", "Dynamisk grense", "Regner mot snittet av tre topper"],
        ["input_boolean.ki_laering_tau", "Lær tidskonstanter", "Måler hvor fort hver sone varmer og kjøler"],
      ]],
      ["Varme og komfort", [
        ["input_boolean.ki_prediktiv_forvarming", "Prediktiv forvarming", "Starter ut fra målt oppvarmingsrate"],
        ["input_boolean.ki_solkompensasjon", "Solkompensasjon", "Trekker fra solvarme i stua"],
        ["input_boolean.ki_vindu_stopp", "Vindu åpent stopper varme", "Sonen settes ned når et vindu/dør står åpent"],
        ["input_boolean.ki_nattsenk_aktiv", "Nattsenking", "Av = ingen soner senkes om natten"],
        ["input_boolean.ki_nattsenk_okonomi", "Økonomisk nattsenking", "Senker bare når sparingen slår gjenoppvarmingen"],
        ["input_boolean.ki_styr_gardiner", "Styr gardiner", "Se egen blokk lenger ned"],
      ]],
      ["Helg og sommer", [
        ["input_boolean.ki_helg_auto", this._l("Helg automatisk ved fravær"), this._l("Torsdag/fredag etter lengre fravær")],
        ["input_boolean.ki_helg_senk_gulvvarme", this._l("Helg senk gulvvarme"), "Gulvvarmen senkes også i helgemodus"],
        ["input_boolean.ki_sommer_auto", "Sommermodus automatisk", "Etter måned og utetemperatur"],
      ]],
      ["Elbil", [
        ["input_boolean.ki_elbil_natt", "Elbil lader om natten", "Laderen er ikke smart — motoren holder av effekt i ladevinduet"],
      ]],
      ["Vann og bad", [
        ["input_boolean.ki_vvb_prisstyring", "VVB prisstyring", "Velger de billigste timene"],
        ["input_boolean.ki_vvb_alltid_pa", "VVB alltid på", "Kobler ut prisstyringen"],
        ["input_boolean.ki_vvb_legionella_aktiv", "Legionellasikring", "Kan ikke blokkeres av sparing når den er på"],
        ["input_boolean.ki_styr_hanklevarmer", "Styr håndklevarmer", "Dusjvinduer og sikkerhetsavstenging"],
      ]],
    ];
    const bryterRad = ([id, navn, sub, hjelp]) => {
      const st = this._st(id);
      return `<div class="rad">
        <div class="radtekst"><div class="radnavn">${esc(navn)}${st ? "" : ' <span class="merke">mangler</span>'}${hjelp ? this._hj(hjelp) : ""}</div>
          ${sub ? `<div class="radsub">${esc(sub)}</div>` : ""}</div>
        <div class="bryter ${st && st.state === "on" ? "on" : ""} ${st ? "" : "mangler"}"
             data-handling="veksle" data-entity="${id}"><span></span></div>
      </div>${hjelp ? this._hjTekst(hjelp) : ""}`;
    };
    const varsler = [
      ["input_boolean.ki_varsel_effekt", "Effektgrense", "Når en time ender over grensen"],
      ["input_boolean.ki_varsel_helg", "Helg", "Fredagsspørsmål, søndagsspørsmål og helg satt automatisk"],
      ["input_boolean.ki_varsel_hjemkomst", "Hjemkomst", "Når oppvarmingen starter uten svar"],
      ["input_boolean.ki_varsel_sommer", "Sommermodus", "Når den slås av/på automatisk"],
      ["input_boolean.ki_varsel_vvb", "Varmtvann", "Lang oppvarming. Feil og forfalt legionella varsles alltid"],
      ["input_boolean.ki_varsel_hanklevarmer", "Håndklevarmer", "Sikkerhetsavstenging"],
    ];
    const varslerPa = this._pa("input_boolean.ki_energi_varsler");
    const diag = [
      ["sensor.ki_uregulert_effekt", "Uregulert effekt"],
      ["sensor.ki_styrt_effekt", "Styrt effekt"],
      ["sensor.strommaler_effekt", "Total effekt"],
      ["sensor.strommaler_imported_energy", "Energiregister"],
      ["sensor.outdoor_meter_temperature", "Utetemperatur"],
      ["sensor.ki_energi_status", "Motorstatus"],
    ];
    // Timesmåleren kan hete flere ting. Vis den som finnes, ikke de som ikke gjør det.
    const maler = TIMESMALER_KANDIDATER.filter((id) => this._st(id));
    const brukt = this._a("sensor.ki_energi_status", "malekilde", "");

    return `
      ${this._overtakelse(false)}
      ${grupper.map(([tittel, liste]) => `
      <div class="blokk">
        <div class="hode"><span>${tittel}</span></div>
        ${liste.map(bryterRad).join("")}
      </div>`).join("")}
      <div class="blokk">
        <div class="hode"><span>Varslinger</span>
          <span class="sub"><div class="bryter ${varslerPa ? "on" : ""}" data-handling="veksle" data-entity="input_boolean.ki_energi_varsler"><span></span></div></span></div>
        <div class="notat" style="padding-top:0">Hovedbryteren over slår alt av. Mottakere velges under Konfigurer → Hus og varsler.</div>
        <div class="${varslerPa ? "" : "dempet"}">${varsler.map(bryterRad).join("")}</div>
        <div class="notat">Kritiske feil (berederen svarer ikke, legionellafrist passert) sendes uansett.</div>
      </div>
      <div class="blokk">
        <div class="hode"><span>Tider</span><span class="sub">Døgnet i huset</span></div>
        ${this._dognplan([
          { navn: "Huset", spenn: [["input_datetime.ki_tid_dag_start", "input_datetime.ki_tid_natt_start", "dag", "Dag"]] },
          { navn: "Cybele", spenn: [["input_datetime.ki_cybele_dag", "input_datetime.ki_cybele_natt", "c", "Våken"],
                                    ["input_datetime.ki_cybele_borte_fra", "input_datetime.ki_cybele_borte_til", "borte", "Borte"]] },
          { navn: "Sebastian", spenn: [["input_datetime.ki_sebastian_vekking", "input_datetime.ki_sebastian_natt", "s", "Våken"]] },
          { navn: "Stue", mark: [["input_datetime.ki_stue_reduksjon_fra", "Reduksjon fra", "advarsel"]] },
        ])}
        <div class="stripeforklaring"><span>Strek = nå · varmen holdes oppe i de fargede båndene</span></div>
      </div>
      <div class="blokk">
        <div class="hode"><span>Dag og natt</span><span class="sub">${this._tidKort("input_datetime.ki_tid_dag_start")}–${this._tidKort("input_datetime.ki_tid_natt_start")}</span></div>
        ${this._tidPar("Dag starter", "input_datetime.ki_tid_dag_start", "Natt starter", "input_datetime.ki_tid_natt_start")}
        ${this._stepperRad("input_number.ki_natt_senk_ute_grense", "Nattsenk kun under", 0, " °C")}
      </div>
      <div class="blokk">
        <div class="hode"><span>Cybele</span><span class="sub">${this._tidKort("input_datetime.ki_cybele_dag")}–${this._tidKort("input_datetime.ki_cybele_natt")}</span></div>
        ${this._tidPar("Opp", "input_datetime.ki_cybele_dag", "Legger seg", "input_datetime.ki_cybele_natt")}
        ${this._tidPar("Borte fra", "input_datetime.ki_cybele_borte_fra", "Hjemme igjen", "input_datetime.ki_cybele_borte_til")}
      </div>
      <div class="blokk">
        <div class="hode"><span>Sebastian</span><span class="sub">${this._tidKort("input_datetime.ki_sebastian_vekking")}–${this._tidKort("input_datetime.ki_sebastian_natt")}</span></div>
        ${this._tidPar("Vekking", "input_datetime.ki_sebastian_vekking", "Vekking helg", "input_datetime.ki_sebastian_vekking_helg")}
        ${this._tidRad("input_datetime.ki_sebastian_natt", "Legger seg")}
      </div>
      <div class="blokk">
        <div class="hode"><span>Elbil</span><span class="sub">${this._tidKort("input_datetime.ki_elbil_fra")}–${this._tidKort("input_datetime.ki_elbil_til")}</span></div>
        ${this._dognplan([{ navn: "Lading", spenn: [["input_datetime.ki_elbil_fra", "input_datetime.ki_elbil_til", "s", "Elbil"]] }])}
        ${this._tidPar("Lader fra", "input_datetime.ki_elbil_fra", "Til", "input_datetime.ki_elbil_til")}
        ${this._stepperRad("input_number.ki_elbil_effekt_kw", "Ladeeffekt", 1, " kW")}
        <div class="notat">5 A på tre faser (400 V) ≈ 3,5 kW, på én fase (230 V) ≈ 1,2 kW. Når lastprofilen har lært natten, teller halvparten.</div>
      </div>
      <div class="blokk">
        <div class="hode"><span>Stue og vindu</span></div>
        ${this._tidRad("input_datetime.ki_stue_reduksjon_fra", "Stue reduksjon fra")}
        ${this._stepperRad("input_number.ki_stue_reduksjon", "Stue reduksjon", 1, " °C")}
        ${this._stepperRad("input_number.ki_vindu_forsinkelse_min", "Vindu: vent før senking", 0, " min")}
        ${this._stepperRad("input_number.ki_vindu_temp", "Vindu: hold temperatur", 1, " °C")}
      </div>
      <div class="blokk">
        <div class="hode"><span>Diagnostikk</span><span class="sub">Rå tilstand</span></div>
        ${diag.map(([id, navn]) => {
          const st = this._st(id);
          return `<div class="rad rad-les" data-handling="mer" data-entity="${id}">
            <div class="prikk p-${st ? "ok" : "feil"}"></div>
            <div class="radtekst"><div class="radnavn">${esc(navn)}</div>
              <div class="radsub">${esc(id)}</div></div>
            <div class="radverdi">${st ? esc(st.state) : "finnes ikke"}</div></div>`;
        }).join("")}
        <div class="rad rad-les" ${maler.length ? `data-handling="mer" data-entity="${maler[0]}"` : ""}>
          <div class="prikk p-${maler.length ? "ok" : "advarsel"}"></div>
          <div class="radtekst"><div class="radnavn">Timesmåler i bruk${this._hj("malekilde")}</div>
            <div class="radsub">${maler.length
              ? esc(maler.join(", "))
              : "Ingen utility_meter funnet — motoren måler timen selv mot energiregisteret"}</div></div>
          <div class="radverdi">${maler.length ? esc(this._s(maler[0])) : "egen måling"}</div>
        </div>
        ${this._hjTekst("malekilde")}
        ${(() => {
          const ok = this._a("sensor.ki_energi_status", "lagring_ok", null);
          const hvor = this._a("sensor.ki_energi_status", "lagring", "ukjent");
          const profil = this._a("sensor.ki_energi_status", "profil_oppforinger", 0);
          const tau = this._a("sensor.ki_energi_status", "tau_soner", 0);
          return `<div class="rad rad-les" data-handling="mer" data-entity="sensor.ki_energi_status">
            <div class="prikk p-${ok === true ? "ok" : ok === false ? "feil" : "advarsel"}"></div>
            <div class="radtekst"><div class="radnavn">Lagring av læring${this._hj("lagring")}</div>
              <div class="radsub">${esc(hvor)} · ${profil} profiloppføringer · ${tau} soner</div></div>
          </div>
          ${this._hjTekst("lagring")}`;
        })()}
        ${brukt ? `<div class="notat">Motoren rapporterer at den bruker: ${esc(brukt)}</div>` : ""}
        <div class="hurtig">
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi" data-tjeneste="fjern_overstyring">Fjern alle overstyringer</div>
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi" data-tjeneste="tick">Kjør motoren nå</div>
        </div>
      </div>`;
  }

  /* ---------------------------- Avansert ---------------------- */

  _avansert() {
    const attr = (this._st("sensor.ki_energi_status") || {}).attributes || {};
    const skjul = ["friendly_name", "icon", "forklaring", "endringer", "laster", "linjer"];
    const rader = [];
    for (const k of Object.keys(attr)) {
      if (skjul.includes(k)) continue;
      let v = attr[k];
      if (typeof v === "object") v = JSON.stringify(v);
      if (typeof v === "boolean") v = v ? "ja" : "nei";
      rader.push([k, String(v)]);
    }

    const lasterAlle = (this._a("sensor.ki_laster", "laster", []) || []).filter((l) => l.type !== "bryter");
    const entMap = {};
    lasterAlle.forEach((l) => { entMap[l.key] = l.entiteter && l.entiteter.length ? l.entiteter : (SONE_ENTITETER[l.key] || []); });
    const soner = Object.keys(entMap).length ? Object.keys(entMap) : Object.keys(SONE_ENTITETER);

    return `
      <div class="blokk">
        <div class="hode"><span>Terskler for fargesonene</span>
          <span class="sub">Prosent av tillatt effekt</span></div>
        ${this._stepperRad("input_number.ki_sone_gul", "Gul fra", 0, " %")}
        ${this._stepperRad("input_number.ki_sone_oransje", "Oransje fra", 0, " %")}
        ${this._stepperRad("input_number.ki_sone_rod", "Rød fra", 0, " %")}
        <div class="notat">Motoren senker først når den ikke får plass i budsjettet.
          Fargene styrer varsling og hvor tidlig varmtvannet må vike, ikke selve
          utkoblingen.</div>
      </div>

      <div class="blokk">
        <div class="hode"><span>Prognose og reserver</span>
          <span class="sub">Brukes til motoren har lært profilen</span></div>
        ${this._stepperRad("input_number.ki_reserve_uregulert_kwh", "Reserve uregulert last", 2, " kW")}
        ${this._stepperRad("input_number.ki_reserve_frokost_kwh", "Reserve frokost", 1, " kW")}
        ${this._stepperRad("input_number.ki_reserve_middag_kwh", "Reserve middag", 1, " kW")}
        <div class="undertittel" style="padding-top:10px">Måltidsvinduer</div>
        ${this._dognplan([{ navn: "Måltider", spenn: [["input_datetime.ki_frokost_start", "input_datetime.ki_frokost_slutt", "ok", "Frokost"], ["input_datetime.ki_middag_start", "input_datetime.ki_middag_slutt", "ok", "Middag"]] }])}
        ${this._tidRad("input_datetime.ki_frokost_start", "Frokost fra")}
        ${this._tidRad("input_datetime.ki_frokost_slutt", "Frokost til")}
        ${this._tidRad("input_datetime.ki_middag_start", "Middag fra")}
        ${this._tidRad("input_datetime.ki_middag_slutt", "Middag til")}
        <div class="notat">Måltidsreservene brukes bare til lastprofilen har nok målinger for
          timen. Etter det vet motoren selv hva komfyren pleier å trekke.</div>
      </div>

      <div class="blokk">
        <div class="hode"><span>Moduser og unntak</span></div>
        ${this._stepperRad("input_number.ki_temp_helg", this._l("Helgetemperatur"), 1, " °C")}
        ${this._stepperRad("input_number.ki_temp_helg_gulvvarme", this._l("Helg gulvvarme"), 1, " °C")}
        ${this._stepperRad("input_number.ki_temp_helg_bad", this._l("Helg bad"), 1, " °C")}
        ${this._stepperRad("input_number.ki_temp_sommer", "Sommertemperatur", 1, " °C")}
        ${this._manedStripe("input_number.ki_sommer_start_maned", "input_number.ki_sommer_slutt_maned", "Sommermodus")}
        ${this._stepperRad("input_number.ki_sommer_start_maned", "Sommer fra måned", 0, "")}
        ${this._stepperRad("input_number.ki_sommer_slutt_maned", "Sommer til måned", 0, "")}
        ${this._stepperRad("input_number.ki_sommer_ute_grense", "Sommer når ute over", 0, " °C")}
        ${this._stepperRad("input_number.ki_helg_auto_timer", "Helg auto etter", 0, " t borte")}
        <div class="notat">Forvarming bruker motorens målte oppvarmingsrate per sone. Sonene
          starter så sent som mulig innenfor budsjettet, og gulvvarme aldri senere enn 45
          minutter før fristen.</div>
      </div>

      <div class="blokk">
        <div class="hode"><span>Helgevarsler</span><span class="sub">Torsdag, fredag og søndag</span></div>
        <div class="notat" style="padding-top:0">${this._hytte
          ? "«Skal dere på hytta i helgen?» sendes torsdag og fredag når hytta er tom. Svarer dere ja, holdes frostsikringen til oppvarmingen må starte for å være ferdig til ankomsttiden fredag."
          : "«Skal dere bort i helgen?» sendes torsdag og fredag, bare hvis dere er hjemme. Svarer dere ja, settes sparemodus i det siste person drar."}</div>
        ${this._dognplan([
          { navn: "Torsdag", mark: [["input_datetime.ki_helg_varsel_tid_torsdag", "Spør", "noytral"]] },
          { navn: "Fredag", mark: [["input_datetime.ki_helg_varsel_tid", "Spør", "noytral"]] },
          { navn: "Søndag", spenn: [["input_datetime.ki_helg_sporsmal_tid", "input_datetime.ki_helg_frist_tid", "advarsel", "Svarfrist"],
                                    ["input_datetime.ki_helg_frist_tid", "input_datetime.ki_hjemkomst_tid", "dag", "Oppvarming"]],
            mark: [["input_datetime.ki_hjemkomst_tid", "Hjemme", "ok"]] },
        ])}
        ${this._tidBryterRad("input_datetime.ki_helg_varsel_tid_torsdag", "input_boolean.ki_helg_spor_torsdag", "Spør torsdag")}
        ${this._tidBryterRad("input_datetime.ki_helg_varsel_tid", "input_boolean.ki_helg_spor_fredag", "Spør fredag")}
        ${this._tidRad("input_datetime.ki_helg_sporsmal_tid", "Spørsmål søndag")}
        ${this._tidRad("input_datetime.ki_helg_frist_tid", "Svarfrist søndag")}
        ${this._tidRad("input_datetime.ki_hjemkomst_tid", this._l("Forventet hjemkomst"))}
        <div class="hurtig">
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi" data-tjeneste="helg_sporsmal">Send spørsmålet nå</div>
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi" data-tjeneste="hjemkomst">${this._l("Start hjemkomst")}</div>
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi" data-tjeneste="hjemkomst_ferdig">${this._l("Avslutt hjemkomst")}</div>
        </div>
        <div class="rad rad-les" data-handling="mer" data-entity="input_boolean.ki_helg_venter_svar">
          <div class="prikk p-${this._pa("input_boolean.ki_helg_venter_svar") ? "advarsel" : "noytral"}"></div>
          <div class="radtekst"><div class="radnavn">Venter på svar${this._hj("venter_svar")}</div></div>
          <div class="radverdi">${this._pa("input_boolean.ki_helg_venter_svar") ? "Ja" : "Nei"}</div>
        </div>
        ${this._hjTekst("venter_svar")}
      </div>

      ${this._gardinKort()}

      <div class="blokk">
        <div class="hode"><span>Varmtvann, avansert${this._hj("vvb_terskel")}</span></div>
        ${this._hjTekst("vvb_terskel")}
        ${this._stepperRad("input_number.ki_vvb_metning_terskel_w", "Effektgrense for utkoblet termostat", 0, " W")}
        ${this._stepperRad("input_number.ki_vvb_maks_min_uten_effekt", "Maks minutter uten effekt etter start", 0, " min")}
        ${this._stepperRad("input_number.ki_vvb_maks_oppvarming_min", "Maks sammenhengende oppvarming", 0, " min")}
        ${this._stepperRad("input_number.ki_vvb_maks_dager", "Hard legionellafrist", 0, " d")}
        ${this._stepperRad("input_number.ki_vvb_effekt_kw", "Antatt effekt", 1, " kW")}
        ${this._stepperRad("input_number.ki_vvb_boost_minutter", "Boost varighet", 0, " min")}
        ${this._stepperRad("input_number.ki_vvb_metning_minutter", "Minutter null effekt før mettet", 0, " min")}
        <div class="notat">Terskelen avgjør hva som regnes som en reell oppvarming.
          Står den for lavt, telles standby som en syklus og legionellasikringen blir
          bekreftet på falskt grunnlag.</div>
      </div>

      <div class="blokk">
        <div class="hode"><span>Tarifftabell${this._hj("tariff")}</span><span class="sub">kW → kr/mnd</span></div>
        ${this._hjTekst("tariff")}
        <div class="rad"><input class="tekst" type="text" data-entity="input_text.ki_tariff_tabell"
          value="${esc(this._s("input_text.ki_tariff_tabell", ""))}" placeholder="2:150,5:250,10:420,15:585,20:755"></div>
        <div class="fakta">${((this._a("sensor.ki_nettleie", "tabell", []) || [])).map(([g, k], i, a) =>
          `<span class="badge ${this._a("sensor.ki_nettleie", "registrert_trinn_kr", null) === k ? "b-ok" : ""}">${i ? a[i - 1][0] : 0}–${g} kW: ${k} kr</span>`).join("")}</div>
      </div>
      <div class="blokk">
        <div class="hode"><span>Motorens råtilstand</span>
          <span class="sub">Alt sensoren rapporterer</span></div>
        ${rader.map(([k, v]) => `<div class="rad">
          <div class="radtekst"><div class="radnavn">${esc(k)}</div></div>
          <div class="radverdi brytbar">${esc(v)}</div></div>`).join("")}
      </div>

      <div class="blokk">
        <div class="hode"><span>Entiteter per sone</span>
          <span class="sub">Rødt = motoren finner den ikke</span></div>
        ${soner.map((k) => {
          const liste = entMap[k] || SONE_ENTITETER[k] || [];
          const mangler = liste.filter((id) => !this._st(id));
          return `<div class="sone ${this._apne.has("e-" + k) ? "apen" : ""}">
            <div class="sonehode" data-handling="apne" data-key="e-${k}">
              <div class="prikk p-${mangler.length ? "feil" : "ok"}"></div>
              <div class="radtekst"><div class="radnavn">${esc(k)}</div>
                <div class="radsub">${mangler.length
                  ? mangler.length + " entitet(er) mangler"
                  : "alle på plass"}</div></div>
            </div>
            <div class="sonekropp">
              ${liste.map((id) => {
                const st = this._st(id);
                return `<div class="rad rad-les" data-handling="mer" data-entity="${id}">
                  <div class="prikk p-${st ? "ok" : "feil"}"></div>
                  <div class="radtekst"><div class="radsub">${esc(id)}</div></div>
                  <div class="radverdi brytbar">${st ? esc(st.state) : "mangler"}</div></div>`;
              }).join("")}
            </div>
          </div>`;
        }).join("")}
      </div>

      <div class="blokk">
        <div class="hode"><span>Handlinger${this._hj("handlinger")}</span></div>
        ${this._hjTekst("handlinger")}
        <div class="hurtig">
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi"
               data-tjeneste="tick">Kjør motoren nå</div>
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi"
               data-tjeneste="fjern_overstyring">Fjern alle overstyringer</div>
          <div class="mini" data-handling="laering" data-hva="tau">Nullstill tidskonstanter</div>
          <div class="mini" data-handling="laering" data-hva="profil">Nullstill lastprofil</div>
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi"
               data-tjeneste="sett_standardverdier">Sett standardverdier${this._hj("standardverdier")}</div>
        </div>
        ${this._hjTekst("standardverdier")}
      </div>`;
  }

  /* ---------------------------- Grafer ------------------------ */

  _grafPlassholder() {
    return `<div class="grafvent">Henter historikk …</div>`;
  }

  async _hentHistorikk() {
    const naa = Date.now();
    if (this._hist && naa - this._histTid < 120000) { this._tegnGrafer(); return; }
    // Timesmåleren kan hete flere ting, og sensor.ki_forbruk_time finnes ikke
    // hos alle. Finn den som er der, ellers står grafen tom uten forklaring.
    this._malerId = null;
    for (const id of TIMESMALER_KANDIDATER) {
      if (this._st(id)) { this._malerId = id; break; }
    }
    const ider = ["sensor.ki_uregulert_effekt", "sensor.ki_styrt_effekt"];
    if (this._malerId) ider.push(this._malerId);
    Object.entries(this._soneGrafer || {}).forEach(([key, g]) => {
      if (!this._apne.has(key)) return;
      g.eff.forEach((e) => { if (!ider.includes(e)) ider.push(e); });
      if (g.temp && !ider.includes(g.temp)) ider.push(g.temp);
    });
    const nokkel = ider.join(",");
    if (this._hist && this._histNokkel !== nokkel) this._hist = null;
    try {
      const start = new Date(naa - 12 * 3600 * 1000).toISOString();
      const res = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start,
        end_time: new Date(naa).toISOString(),
        entity_ids: ider,
        minimal_response: true,
        no_attributes: true,
      });
      this._hist = res || {};
      this._histTid = naa;
      this._histNokkel = nokkel;
      this._tegnGrafer();
    } catch (e) {
      const el = this._rot.querySelector(".graf");
      if (el) el.innerHTML = `<div class="grafvent">Fant ikke historikk (${esc(e.message || e)})</div>`;
    }
  }

  _serie(id, timer) {
    const rå = (this._hist || {})[id] || [];
    const fra = Date.now() / 1000 - timer * 3600;
    return rå.map((p) => ({ t: p.lu || p.last_updated, v: Number(p.s ?? p.state) }))
             .filter((p) => isFinite(p.v) && p.t >= fra);
  }

  _tegnGrafer() {
    Object.entries(this._soneGrafer || {}).forEach(([key, g]) => {
      const el = this._rot.getElementById("graf-sone-" + key);
      if (!el) return;
      const eff = g.eff.map((e) => this._serie(e, 6));
      // summer ovnene: bruk første som tidsakse, legg til siste kjente verdi fra de andre
      let sum = eff[0] || [];
      if (eff.length > 1) {
        const alle = eff.flat().map((p) => p.t).sort((a, b) => a - b);
        sum = alle.map((t) => ({ t, v: eff.reduce((s, ser) => { let v = 0; for (const p of ser) { if (p.t <= t) v = p.v; else break; } return s + v; }, 0) }));
      }
      const tempAttr = g.temp && g.temp.startsWith("climate.");
      const temp = g.temp && !tempAttr ? this._serie(g.temp, 6) : [];
      const serier = [];
      if (sum.length) serier.push({ punkter: sum, klasse: "l1", navn: "Effekt" });
      if (temp.length) serier.push({ punkter: temp, klasse: "l2", navn: "Temp", akse2: true });
      el.innerHTML = serier.length
        ? this._svg(serier, { enhet: "" }) + `<div class="skrubb" hidden><div class="skrubblinje"></div><div class="skrubbtekst"></div></div>`
        : `<div class="grafvent">Ingen historikk ennå${tempAttr ? " (temperatur ligger som attributt på termostaten og lagres ikke som egen serie)" : ""}</div>`;
      this._monterSkrubb(el, serier.map((s) => ({ punkter: s.punkter, navn: s.navn })), "");
    });
    const timeGraf = this._rot.getElementById("graf-time");
    if (timeGraf) {
      if (!this._malerId) {
        timeGraf.innerHTML = `<div class="grafvent">Fant ingen timesmåler å tegne.
          Motoren måler timen selv, men den målingen lagres ikke i historikken.</div>`;
      } else {
        const s = this._serie(this._malerId, 12);
        const grense = Number(this._a("sensor.ki_energi_status", "grense_kwh", NaN));
        timeGraf.innerHTML = s.length
          ? this._svg([{ punkter: s, klasse: "l1" }], { grense, enhet: " kWh" })
          : `<div class="grafvent">Ingen historikk for ${esc(this._malerId)} ennå</div>`;
      }
    }
    const effGraf = this._rot.getElementById("graf-effekt");
    if (effGraf) {
      const naa = Date.now() / 1000;
      const live = (id, s) => { const v = this._n(id); if (isFinite(v)) s.push({ t: naa, v: v / 1000 }); return s; };
      const a = live("sensor.ki_uregulert_effekt", this._serie("sensor.ki_uregulert_effekt", 6).map((p) => ({ t: p.t, v: p.v / 1000 })));
      const b = live("sensor.ki_styrt_effekt", this._serie("sensor.ki_styrt_effekt", 6).map((p) => ({ t: p.t, v: p.v / 1000 })));
      effGraf.innerHTML = (a.length || b.length)
        ? this._svg([{ punkter: a, klasse: "l1", navn: "Uregulert" }, { punkter: b, klasse: "l2", navn: "Styrt" }], { enhet: " kW" })
          + `<div class="skrubb" hidden><div class="skrubblinje"></div><div class="skrubbtekst"></div></div>`
        : `<div class="grafvent">Ingen historikk ennå — sensorene er nye</div>`;
      this._monterSkrubb(effGraf, [{ punkter: a, navn: "Uregulert" }, { punkter: b, navn: "Styrt" }], " kW");
    }
  }

  // Avlesing med finger/mus: viser tid og verdi der man peker.
  _monterSkrubb(el, serier, enhet) {
    const alle = serier.flatMap((s) => s.punkter);
    if (!alle.length) return;
    const t0 = Math.min(...alle.map((p) => p.t)), t1 = Math.max(...alle.map((p) => p.t));
    const boks = el.querySelector(".skrubb"), linje = el.querySelector(".skrubblinje"), tekst = el.querySelector(".skrubbtekst");
    if (!boks) return;
    const verdiVed = (s, t) => { let v = null; for (const p of s.punkter) { if (p.t <= t) v = p.v; else break; } return v; };
    const vis = (ev) => {
      const r = el.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const t = t0 + f * (t1 - t0);
      const d = new Date(t * 1000);
      const deler = serier.map((s) => { const v = verdiVed(s, t); return v == null ? "" : `${s.navn} ${nf(v, 2)}${enhet}`; }).filter(Boolean);
      boks.hidden = false;
      linje.style.left = `${(f * 100).toFixed(1)}%`;
      tekst.style.left = f > 0.6 ? "auto" : `calc(${(f * 100).toFixed(1)}% + 6px)`;
      tekst.style.right = f > 0.6 ? `calc(${((1 - f) * 100).toFixed(1)}% + 6px)` : "auto";
      tekst.textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} · ${deler.join(" · ")}`;
      ev.preventDefault();
    };
    el.addEventListener("pointerdown", (ev) => { el.setPointerCapture(ev.pointerId); vis(ev); });
    el.addEventListener("pointermove", (ev) => { if (ev.buttons || ev.pointerType === "touch") vis(ev); });
    const skjul = () => { boks.hidden = true; };
    el.addEventListener("pointerup", skjul); el.addEventListener("pointercancel", skjul); el.addEventListener("pointerleave", skjul);
  }

  _svg(serier, opt = {}) {
    const B = 340, H = 90, pad = 4;
    const alle = serier.flatMap((s) => s.punkter);
    if (!alle.length) return `<div class="grafvent">Ingen data</div>`;
    const t0 = Math.min(...alle.map((p) => p.t));
    const t1 = Math.max(...alle.map((p) => p.t));
    const prim = serier.filter((s) => !s.akse2).flatMap((s) => s.punkter);
    let vMax = Math.max(...prim.map((p) => p.v), opt.grense || 0);
    const vMin = Math.min(0, ...prim.map((p) => p.v));
    if (vMax === vMin) vMax = vMin + 1;
    const x = (t) => pad + ((t - t0) / Math.max(t1 - t0, 1)) * (B - 2 * pad);
    const y = (v) => H - pad - ((v - vMin) / (vMax - vMin)) * (H - 2 * pad);
    // sekundær akse (f.eks. temperatur) skaleres for seg selv
    const sek = serier.filter((s) => s.akse2).flatMap((s) => s.punkter);
    let s2Max = sek.length ? Math.max(...sek.map((p) => p.v)) + 0.5 : 1, s2Min = sek.length ? Math.min(...sek.map((p) => p.v)) - 0.5 : 0;
    if (s2Max === s2Min) s2Max = s2Min + 1;
    const y2 = (v) => H - pad - ((v - s2Min) / (s2Max - s2Min)) * (H - 2 * pad);

    const linjer = serier.filter((s) => s.punkter.length).map((s) =>
      `<polyline class="${s.klasse}" points="${s.punkter.map((p) => `${x(p.t).toFixed(1)},${(s.akse2 ? y2 : y)(p.v).toFixed(1)}`).join(" ")}"></polyline>`
    ).join("");
    const grenselinje = isFinite(opt.grense) && opt.grense > 0
      ? `<line class="grense" x1="${pad}" x2="${B - pad}" y1="${y(opt.grense)}" y2="${y(opt.grense)}"></line>` : "";

    return `<svg viewBox="0 0 ${B} ${H}" preserveAspectRatio="none">${grenselinje}${linjer}</svg>
      <div class="grafakse"><span>${nf(vMax, 1)}${opt.enhet || ""}</span><span>${nf(vMin, 1)}${opt.enhet || ""}</span></div>`;
  }

  /* ---------------------------- Interaksjon ------------------- */

  _klikk(ev) {
    const el = ev.composedPath().find((n) => n.dataset && n.dataset.handling);
    if (!el) return;
    const h = el.dataset.handling;

    if (h === "fane") {
      this._fane = el.dataset.fane;
      this._lagreFane(this._fane);
      this._tegn();
    } else if (h === "underfane") {
      this._underfane = el.dataset.id;
      this._tegn();
    } else if (h === "hero") {
      this._heroApen = !this._heroApen;
      this._tegnHero();
    } else if (h === "mnd") {
      const m = Number(el.dataset.mnd);
      if (this._mndValg && this._mndValg.fraId === el.dataset.fra) {
        this._kall("input_number", "set_value", { entity_id: el.dataset.fra, value: this._mndValg.fra });
        this._kall("input_number", "set_value", { entity_id: el.dataset.til, value: m });
        this._mndValg = null;
      } else {
        this._mndValg = { fraId: el.dataset.fra, fra: m };
        this._tegn();
      }
    } else if (h === "subkollaps") {
      const sek = el.closest(".sub-seksjon");
      const lukket = sek && sek.classList.toggle("lukket");
      this._kollaps[el.dataset.id] = !lukket;
      this._lagreKollaps();
      if (this._fane === "soner") this._hentHistorikk();
    } else if (h === "kollaps") {
      const bl = el.closest(".blokk");
      const lukket = bl && bl.classList.toggle("lukket");
      this._kollaps[el.dataset.id] = !lukket;
      this._lagreKollaps();
    } else if (h === "prio") {
      this._kall("ki_energi", "sett_prio", { sone: el.dataset.key, prio: Number(el.dataset.prio) });
    } else if (h === "leggetid") {
      this._kall("ki_energi", "leggetid", { sone: el.dataset.key, avbryt: el.dataset.avbryt === "1" });
    } else if (h === "mer") {
      this.dispatchEvent(new CustomEvent("hass-more-info", {
        detail: { entityId: mapId(el.dataset.entity) }, bubbles: true, composed: true }));
    } else if (h === "veksle") {
      const st = this._st(el.dataset.entity);
      if (!st) return;
      this._kall(el.dataset.entity.split(".")[0], st.state === "on" ? "turn_off" : "turn_on",
        { entity_id: el.dataset.entity });
    } else if (h === "bryter") {
      const st = this._st(el.dataset.entity);
      if (!st) return;
      this._kall("switch", st.state === "on" ? "turn_off" : "turn_on",
        { entity_id: el.dataset.entity });
    } else if (h === "apne") {
      const k = el.dataset.key;
      if (this._apne.has(k)) this._apne.delete(k); else this._apne.add(k);
      this._tegn();
    } else if (h === "tall") {
      this._juster(el.dataset.entity, Number(el.dataset.dir));
    } else if (h === "ov") {
      const k = el.dataset.key;
      const laster = this._a("sensor.ki_laster", "laster", []) || [];
      const l = laster.find((x) => x.key === k);
      const naa = this._ov[k] !== undefined ? this._ov[k] : (l ? l.mal : 21);
      this._ov[k] = Math.round((naa + Number(el.dataset.dir) * 0.5) * 2) / 2;
      this._tegn();
    } else if (h === "ovsett") {
      const k = el.dataset.key;
      if (this._ov[k] === undefined) return;
      this._kall("ki_energi", "overstyr",
        { sone: k, temp: this._ov[k], minutter: Number(el.dataset.min) });
      delete this._ov[k];
    } else if (h === "ovfjern") {
      this._kall("ki_energi", "fjern_overstyring", { sone: el.dataset.key });
    } else if (h === "tjeneste") {
      this._kall(el.dataset.domene, el.dataset.tjeneste, {});
    } else if (h === "hjelp") {
      const id = el.dataset.id;
      if (this._hjelpApen.has(id)) this._hjelpApen.delete(id); else this._hjelpApen.add(id);
      this._tegn();
    } else if (h === "laering") {
      this._kall("ki_energi", "nullstill_laering", { hva: el.dataset.hva });
    }
  }

  _juster(id, dir) {
    const st = this._st(id);
    if (!st) return;
    const steg = Number(st.attributes.step ?? 0.5) || 0.5;
    const min = Number(st.attributes.min ?? -100);
    const maks = Number(st.attributes.max ?? 1000);
    const v = Math.min(maks, Math.max(min, Number((Number(st.state) + dir * steg).toFixed(4))));
    this._kall("input_number", "set_value", { entity_id: id, value: v });
  }

  _endre(ev) {
    const tall = ev.composedPath().find((n) => n && (n.type === "number" || n.tagName === "SELECT") && n.dataset && n.dataset.entity);
    if (tall) {
      const v = Number(String(tall.value).replace(",", "."));
      if (isFinite(v)) this._kall("input_number", "set_value", { entity_id: tall.dataset.entity, value: v });
      return;
    }
    const tekst = ev.composedPath().find((n) => n && n.type === "text" && n.dataset && n.dataset.entity);
    if (tekst) {
      this._kall("input_text", "set_value", { entity_id: tekst.dataset.entity, value: tekst.value });
      return;
    }
    const el = ev.composedPath().find((n) => n && n.type === "time");
    if (!el) return;
    if (el.value) {
      const [t, m] = el.value.split(":");
      this._kall("input_datetime", "set_datetime",
        { entity_id: el.dataset.entity, time: `${t}:${m}:00` });
    }
  }

  /* ---------------------------- Stil -------------------------- */

  static get stil() {
    return `
      :host { display:block; overflow-x:hidden; }
      * { box-sizing:border-box; min-width:0; }
      ha-card { background:transparent; border:none; box-shadow:none; padding:0;
        max-width:100%; overflow:hidden; }
      .wrap { display:flex; flex-direction:column; gap:10px; color: var(--gray1000, var(--primary-text-color)); }
      .tittel { font-size:20px; font-weight:600; padding:2px 6px 0; }

      .hero { display:grid; grid-template-columns:96px 1fr; align-items:center; gap:14px;
        background: var(--gray200, var(--secondary-background-color)); border-radius:24px; padding:16px; }
      .ring { position:relative; width:88px; height:88px; cursor:pointer; }
      .ring svg { width:88px; height:88px; transform: rotate(-90deg); }
      .ring circle { fill:none; stroke-width:8; stroke-linecap:round; }
      .spor { stroke: rgba(128,128,128,.24); }
      .fyll { stroke: var(--green, #4caf50); transition: stroke-dashoffset .6s cubic-bezier(.2,.7,.3,1); }
      .hero[data-sone="gul"] .fyll { stroke: var(--yellow, #f2c94c); }
      .hero[data-sone="oransje"] .fyll { stroke: var(--orange, #fc6d09); }
      .hero[data-sone="rod"] .fyll, .hero[data-sone="kritisk"] .fyll { stroke: var(--red, #f44336); }
      .hero[data-sone="av"] .fyll, .hero[data-sone="fallback"] .fyll { stroke: rgba(128,128,128,.5); }
      .ringtall { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
        font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; }
      .ringtall span { font-size:13px; opacity:.6; }
      .heronavn { font-size:19px; font-weight:600; }
      .heroforklaring { font-size:13.5px; opacity:.75; line-height:1.4; margin-top:3px; }
      .herolinje { display:flex; gap:12px; font-size:12.5px; opacity:.6; margin-top:6px; }
      .herolinje ha-icon { --mdc-icon-size:15px; vertical-align:-3px; }
      .merke { font-size:10.5px; font-weight:600; padding:2px 7px; border-radius:75px;
        background: rgba(128,128,128,.3); vertical-align:middle; }

      .faner { display:flex; gap:4px; padding:4px; border-radius:20px; overflow-x:auto;
        background: var(--gray200, var(--secondary-background-color)); scrollbar-width:none;
        max-width:100%; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; }
      .faner::-webkit-scrollbar { display:none; }
      .underfaner { display:flex; gap:6px; margin:2px 0 10px; }
      .underfane { flex:1; display:flex; align-items:center; justify-content:center; gap:6px;
        padding:9px 10px; border-radius:75px; font-size:13px; font-weight:600; cursor:pointer;
        background: rgba(128,128,128,.14); opacity:.7; }
      .underfane ha-icon { --mdc-icon-size:17px; }
      .underfane.aktiv { opacity:1; background: rgba(128,128,128,.28); }
      .bar { position:relative; height:8px; border-radius:75px; background: rgba(128,128,128,.18); margin:10px 0 6px; overflow:visible; }
      .bar-fyll { height:100%; border-radius:75px; background: var(--green, #4caf50); transition: width .4s; }
      .bar-fyll.f-advarsel { background: var(--orange, #fc6d09); }
      .bar-fyll.f-feil { background: var(--red, #f44336); }
      .bar-fyll.f-noytral { background: rgba(128,128,128,.4); }
      .bar-mark { position:absolute; top:-3px; width:2px; height:14px; background: rgba(128,128,128,.7); border-radius:2px; }
      .bar-tekst { display:flex; justify-content:space-between; font-size:11.5px; opacity:.6; padding-bottom:8px; }
      .b-noytral { background: rgba(128,128,128,.2); }
      .fane { flex:1 0 auto; display:flex; flex-direction:column; align-items:center; gap:2px;
        padding:8px 12px; border-radius:16px; font-size:11.5px; cursor:pointer; opacity:.55;
        white-space:nowrap; transition: background .18s, opacity .18s; }
      .fane ha-icon { --mdc-icon-size:20px; }
      .fane.aktiv { background: var(--active-small, var(--active-big, var(--primary-color)));
        color: var(--gray100, #fafbfc); opacity:1; font-weight:600; }

      .blokk { background: var(--gray200, var(--secondary-background-color));
        border-radius:24px; padding:8px 14px 14px; max-width:100%; overflow:hidden; }
      .blokk + .blokk { margin-top:10px; }
      .hode { display:flex; justify-content:space-between; align-items:center; gap:10px;
        font-size:14.5px; font-weight:600; opacity:.7; padding:8px 4px; min-width:0; }
      .hode > span:first-child { display:flex; align-items:center; gap:6px; min-width:0; flex:1 1 auto; }
      .hodeikon { --mdc-icon-size:18px; opacity:.9; flex:0 0 auto; }
      .sub { font-weight:500; text-align:right; font-size:12.5px; flex:0 1 auto; min-width:0;
        overflow-wrap:anywhere; max-width:60%; }
      .dempet { opacity:.4; pointer-events:none; }
      .hero { position:relative; }
      .heroknapp { position:absolute; top:10px; right:10px; cursor:pointer; opacity:.5; width:28px; height:28px;
        display:flex; align-items:center; justify-content:center; border-radius:50%; background: rgba(128,128,128,.14); }
      .heroknapp ha-icon { --mdc-icon-size:20px; }
      .herotekst { padding-right:26px; }
      .kollapsikon { --mdc-icon-size:20px; opacity:.6; transition: transform .2s; flex:0 0 auto; }
      .hode[data-handling="kollaps"] { cursor:pointer; user-select:none; }
      .blokk.lukket > *:not(.hode) { display:none; }
      .blokk.lukket .kollapsikon { transform: rotate(-90deg); }
      .blokk.lukket { padding-bottom:8px; }
      .hode .sub .bryter { margin:0; }
      .mini.aktiv { background: rgba(76,175,80,.25); }
      .mini ha-icon { --mdc-icon-size:15px; vertical-align:-3px; margin-right:4px; }
      .tidslinje { padding:30px 4px 6px; }
      .tl-spor { position:relative; height:44px; border-radius:8px; background: rgba(128,128,128,.14); overflow:visible; }
      .tl-spenn { position:absolute; top:12px; height:20px; border-radius:5px; background: rgba(128,128,128,.28); }
      .tl-spenn.dag { background: rgba(242,201,76,.35); }
      .tl-spenn.borte { background: rgba(128,128,128,.45); top:18px; height:8px; }
      .tl-mark { position:absolute; top:0; height:44px; width:0; }
      .tl-mark i { position:absolute; left:-1px; top:4px; width:2px; height:36px; background: currentColor; border-radius:2px; opacity:.9; }
      .tl-mark span { position:absolute; left:4px; font-size:10.5px; font-weight:600; white-space:nowrap; opacity:.85;
        transform: translateX(-50%); left:0; }
      .tl-mark span.over { top:-15px; } .tl-mark span.over2 { top:-28px; } .tl-mark span.under { bottom:-15px; }
      .tl-mark.ok { color: var(--green, #4caf50); } .tl-mark.noytral { color: rgba(128,128,128,.9); }
      .tl-mark.advarsel { color: var(--orange, #fc6d09); } .tl-mark.c { color: var(--purple, #9c27b0); } .tl-mark.s { color: var(--active-big, var(--primary-color)); }
      .tl-naa { position:absolute; top:0; bottom:0; width:2px; margin-left:-1px; background: var(--primary-text-color); opacity:.5; }
      .tl-akse { display:flex; justify-content:space-between; font-size:10px; opacity:.5; padding-top:18px; font-variant-numeric:tabular-nums; }
      .tidpar { gap:8px; }
      .tidpar label { flex:1 1 0; min-width:0; display:flex; align-items:center; justify-content:space-between; gap:6px; }
      .tidpar label span { font-size:13px; font-weight:500; opacity:.85; }
      .tid.dempet { opacity:.4; }
      .sonetemp { flex:0 0 auto; }
      .sonekropp .stepper, .rad .stepper { flex:0 0 auto; }
      .stegverdi { min-width:64px; }
      .rad.kompakt { padding:4px 2px; }
      select.velger { font-family:inherit; font-size:14px; font-weight:600; color:inherit;
        background: rgba(128,128,128,.16); border:0; border-radius:75px; padding:6px 28px 6px 12px;
        -webkit-appearance:none; appearance:none; text-align:right; max-width:50%; min-width:96px; cursor:pointer;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1l5 5 5-5' fill='none' stroke='%23888' stroke-width='2'/></svg>");
        background-repeat:no-repeat; background-position:right 10px center; }
      select.velger:focus { outline:none; box-shadow:0 0 0 2px rgba(128,128,128,.35); }
      select.velger.mangler { opacity:.35; pointer-events:none; }
      select.velger option { color: initial; }
      .stepper { padding:1px; gap:1px; }
      .steg { width:26px; height:26px; font-size:16px; }
      input.stegverdi { width:58px; min-width:0; border:0; background:transparent; color:inherit; font:inherit;
        font-weight:600; font-size:13.5px; text-align:right; padding:0 2px; -moz-appearance:textfield; }
      input.stegverdi::-webkit-outer-spin-button, input.stegverdi::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
      input.stegverdi:focus { outline:none; background: rgba(128,128,128,.14); border-radius:8px; }
      .stepper .enhet { font-size:11px; opacity:.6; padding-right:4px; min-width:18px; }
      .radverdi.kort { white-space:nowrap; flex:0 0 auto; max-width:none; overflow:visible; }
      .sub-seksjon { margin-top:6px; border-top:1px solid rgba(128,128,128,.14); }
      .subhode { display:flex; align-items:center; gap:8px; padding:8px 2px; cursor:pointer; user-select:none;
        font-size:13px; font-weight:600; opacity:.75; }
      .subhode > span:first-child { flex:1 1 auto; }
      .subhode .sub { flex:0 1 auto; font-weight:500; opacity:.8; }
      .sub-seksjon.lukket .subkropp { display:none; }
      .sub-seksjon.lukket .kollapsikon { transform: rotate(-90deg); }
      .dogngraf { position:relative; height:120px; margin:26px 0 4px; }
      .dg-soyler { position:absolute; inset:0; display:flex; align-items:flex-end; gap:2px; }
      .dg-dag { flex:1 1 0; min-width:0; height:100%; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; position:relative; }
      .dg-soyle { width:100%; border-radius:3px 3px 0 0; background: rgba(128,128,128,.32); min-height:0; }
      .dg-dag.topp .dg-soyle { background: var(--green, #4caf50); }
      .dg-dag.est .dg-soyle { background: repeating-linear-gradient(45deg, rgba(128,128,128,.5) 0 3px, rgba(128,128,128,.2) 3px 6px); }
      .dg-dag.ekstern .dg-soyle { background: repeating-linear-gradient(45deg, rgba(128,128,128,.35) 0 3px, transparent 3px 6px); border:1px dashed rgba(128,128,128,.6); }
      .dg-dag.idag .dg-soyle { outline:2px solid var(--primary-text-color); outline-offset:-2px; }
      .dg-dag span { font-size:9px; opacity:.55; height:12px; line-height:12px; }
      .dg-hull { position:absolute; top:-8px; width:5px; height:5px; border-radius:50%; background: var(--orange, #fc6d09); }
      .dg-linje { position:absolute; left:0; right:0; height:0; border-top:1px dashed rgba(128,128,128,.7); z-index:1; pointer-events:none; }
      .dg-linje.mal { border-color: var(--red, #f44336); }
      .dg-linje span { position:absolute; right:0; top:-14px; font-size:10px; opacity:.7; }
      .dg-linje.grense span { top:2px; }
      .s-est { background: repeating-linear-gradient(45deg, rgba(128,128,128,.5) 0 3px, rgba(128,128,128,.2) 3px 6px); }
      .s-ekst { border:1px dashed rgba(128,128,128,.7); }
      .dognplan { padding:8px 0 2px; }
      .dp-rad { display:grid; grid-template-columns:72px 1fr; align-items:center; gap:8px; height:34px; }
      .dp-navn { font-size:12px; font-weight:600; opacity:.75; text-align:right; padding-right:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .dp-spor { position:relative; height:26px; border-radius:6px; background: rgba(128,128,128,.12);
        background-image: repeating-linear-gradient(90deg, rgba(128,128,128,.18) 0 1px, transparent 1px 12.5%); }
      .dp-spenn { position:absolute; top:3px; height:20px; border-radius:5px; background: rgba(128,128,128,.35); overflow:hidden; }
      .dp-spenn span { font-size:10.5px; font-weight:600; line-height:20px; padding:0 6px; white-space:nowrap; opacity:.9; }
      .dp-spenn.dag, .dp-spenn.ok { background: rgba(76,175,80,.4); }
      .dp-spenn.c { background: rgba(156,39,176,.4); } .dp-spenn.s { background: rgba(33,150,243,.4); }
      .dp-spenn.borte { background: rgba(128,128,128,.55); top:9px; height:8px; } .dp-spenn.borte span { display:none; }
      .dp-spenn.advarsel { background: rgba(252,109,9,.4); }
      .dp-mark { position:absolute; top:0; height:26px; width:0; }
      .dp-mark i { position:absolute; left:-1.5px; top:2px; width:3px; height:22px; border-radius:2px; background: currentColor; }
      .dp-mark span { position:absolute; left:5px; top:5px; font-size:10.5px; font-weight:600; white-space:nowrap; }
      .dp-mark.ok { color: var(--green, #4caf50); } .dp-mark.noytral { color: rgba(128,128,128,.95); } .dp-mark.advarsel { color: var(--orange, #fc6d09); }
      .dp-naa { position:absolute; top:-3px; bottom:-3px; width:2px; margin-left:-1px; background: var(--primary-text-color); opacity:.55; }
      .dp-akse { height:16px; } .dp-akse .dp-spor { background:none; height:14px; display:flex; justify-content:space-between; font-size:9.5px; opacity:.5; font-variant-numeric:tabular-nums; }
      .dp-akse .dp-spor span { width:0; }
      .mnd { cursor:pointer; height:30px; font-size:10px; }
      .mnd.venter { outline:2px dashed var(--orange, #fc6d09); outline-offset:-2px; }
      .s-dag { background: rgba(242,201,76,.5); } .s-borte { background: rgba(128,128,128,.4); }
      .mstripe { display:grid; grid-template-columns:repeat(12,1fr); gap:3px; padding:8px 0 2px; }
      .mnd { height:26px; border-radius:6px; background: rgba(128,128,128,.14); display:flex; align-items:center; justify-content:center; font-size:10.5px; opacity:.85; }
      .mnd.inne { background: var(--green, #4caf50); color:#fff; }
      .mnd.naa { outline:2px solid var(--primary-text-color); outline-offset:-2px; }
      .skrubb { position:absolute; inset:0; pointer-events:none; }
      .skrubblinje { position:absolute; top:0; bottom:6px; width:1px; background: var(--primary-text-color); opacity:.6; }
      .skrubbtekst { position:absolute; top:4px; font-size:11px; padding:3px 7px; border-radius:8px; white-space:nowrap;
        background: var(--card-background-color, #fff); box-shadow:0 1px 4px rgba(0,0,0,.2); font-variant-numeric:tabular-nums; }
      .graf { touch-action:none; cursor:crosshair; }
      .tegnforklaring .live { margin-left:auto; font-variant-numeric:tabular-nums; }
      .tegnforklaring .grafles { flex-basis:100%; opacity:.5; font-size:11px; }
      .pulser { display:inline-block; width:8px; height:8px; border-radius:50%; background: var(--green, #4caf50); margin-right:4px;
        animation: kipuls 1.6s ease-in-out infinite; }
      @keyframes kipuls { 0%,100% { opacity:1; } 50% { opacity:.3; } }
      .herodetaljer { grid-column:1 / -1; border-top:1px solid rgba(128,128,128,.18); padding-top:10px; }
      .tanke { font-size:13.5px; line-height:1.5; padding:3px 0 3px 12px; position:relative; overflow-wrap:anywhere; }
      .tanke::before { content:""; position:absolute; left:0; top:11px; width:5px; height:5px; border-radius:50%;
        background: rgba(128,128,128,.6); }
      .fakta ha-icon { --mdc-icon-size:14px; vertical-align:-3px; margin-right:3px; }
      .stripe { display:grid; grid-template-columns:repeat(24, 1fr); gap:2px; height:64px; align-items:end;
        padding:6px 0 0; }
      .time { display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; min-width:0; }
      .time .soyle { width:100%; border-radius:3px 3px 0 0; background: rgba(128,128,128,.28); }
      .time.vindu .soyle { background: rgba(128,128,128,.45); }
      .time.valgt .soyle { background: var(--green, #4caf50); }
      .time.naa .soyle { outline:2px solid var(--primary-text-color); outline-offset:-2px; }
      .time span { font-size:9px; opacity:.55; height:12px; line-height:12px; font-variant-numeric:tabular-nums; }
      .stripeforklaring { display:flex; flex-wrap:wrap; gap:10px; font-size:11.5px; opacity:.65; padding:2px 0 10px; }
      .stripeforklaring i { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:4px; vertical-align:-1px; }
      .s-valgt { background: var(--green, #4caf50); } .s-vindu { background: rgba(128,128,128,.45); } .s-pris { background: rgba(128,128,128,.28); }
      .notat { font-size:12.5px; opacity:.6; padding:8px 2px 0; line-height:1.45;
        overflow-wrap:anywhere; }
      .stor { font-size:30px; font-weight:600; padding:4px 2px; font-variant-numeric:tabular-nums; }
      .stor small { font-size:14px; font-weight:500; opacity:.55; }
      .konklusjon { font-size:14.5px; line-height:1.5; padding:4px 2px 10px;
        overflow-wrap:anywhere; }
      .varsel { margin-top:10px; padding:10px 12px; border-radius:14px; font-size:13px;
        background: rgba(244,67,54,.18); }

      .tallrad { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
      .tallrad.fire { grid-template-columns:repeat(4,1fr); }
      .tall { background: rgba(128,128,128,.12); border-radius:16px; padding:10px 6px; text-align:center; }
      .tall b { display:block; font-size:18px; font-variant-numeric:tabular-nums; }
      .tall span { font-size:11px; opacity:.6; }
      .spor2 { height:10px; border-radius:6px; background: rgba(128,128,128,.24);
        overflow:hidden; margin:10px 0 6px; }
      .fyll2 { height:100%; background: var(--active-big, var(--primary-color)); transition: width .5s ease; }
      .under { display:flex; justify-content:space-between; gap:10px; font-size:12.5px; opacity:.6; }

      .rutenett { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      .chip { display:grid; grid-template-columns:50px 1fr; align-items:center; gap:8px; height:60px;
        padding-left:4px; border-radius:75px; cursor:pointer; background: rgba(128,128,128,.12);
        transition: background .18s, color .18s; }
      .chip.pa { background: var(--active-big, var(--primary-color)); color: var(--gray100,#fafbfc); }
      .chipikon { width:50px; height:50px; border-radius:50%; display:flex; align-items:center;
        justify-content:center; background: rgba(128,128,128,.16); }
      .chipikon ha-icon { --mdc-icon-size:22px; }
      .chipnavn { font-size:14px; font-weight:500; }
      .chipsub { font-size:12px; opacity:.65; }

      .rad { display:flex; align-items:center; gap:10px; padding:9px 2px; }
      .rad + .rad { border-top:1px solid rgba(128,128,128,.14); }
      .rad-les { cursor:pointer; }
      .radtekst { flex:1 1 auto; min-width:0; }
      .radnavn { font-size:14.5px; font-weight:500; overflow-wrap:anywhere; }
      .radsub { font-size:12.5px; opacity:.6; line-height:1.35; overflow-wrap:anywhere; }
      /* Verdien krymper aldri under sitt eget innhold (ellers blir «2 058 W» til «2058 …»);
         teksten til venstre er den som må vike. Bare .brytbar får brekke. */
      .radverdi { font-size:13.5px; font-weight:600; opacity:.85; flex:0 0 auto;
        font-variant-numeric:tabular-nums; white-space:nowrap; text-align:right;
        overflow:hidden; text-overflow:ellipsis; max-width:50%; min-width:0; }
      /* Lange verdier, som råattributter og entitets-ID-er, skal brekke i
         stedet for å presse kortet ut i bredden. */
      .radverdi.brytbar { white-space:normal; overflow-wrap:anywhere; flex:0 1 auto;
        text-overflow:clip; max-width:60%; }
      .hjelplinje { font-size:12px; font-weight:600; opacity:.5; padding:10px 2px 2px; }
      .hjelp { display:inline-flex; align-items:center; justify-content:center;
        width:17px; height:17px; min-width:17px; border-radius:50%; cursor:pointer;
        font-size:11px; font-weight:700; margin-left:6px; vertical-align:1px;
        background: rgba(128,128,128,.28); opacity:.8; user-select:none; }
      .hjelp:active { transform: scale(.9); }
      .hjelptekst { font-size:12.5px; line-height:1.5; opacity:.75; overflow-wrap:anywhere;
        margin:2px 0 8px; padding:10px 12px; border-radius:14px;
        background: rgba(128,128,128,.12); }
      .prikk { width:10px; height:10px; min-width:10px; border-radius:50%; background: rgba(128,128,128,.4); }
      .p-ok { background: var(--green, #4caf50); }
      .p-advarsel { background: var(--orange, #fc6d09); }
      .p-feil { background: var(--red, #f44336); }
      .p-noytral { background: rgba(128,128,128,.45); }
      .badge { font-size:11px; font-weight:600; padding:2px 8px; border-radius:75px;
        background: rgba(128,128,128,.2); }
      .b-ok { background: rgba(76,175,80,.25); }
      .b-advarsel { background: rgba(252,109,9,.25); }
      .b-feil { background: rgba(244,67,54,.25); }

      .sone { border-radius:18px; background: rgba(128,128,128,.10); margin-bottom:6px; overflow:hidden; }
      .sonehode { display:flex; align-items:center; gap:10px; padding:10px; cursor:pointer; }
      .sonetemp { text-align:right; white-space:nowrap; }
      .sonetemp b { font-size:16px; font-variant-numeric:tabular-nums; }
      .sonetemp span { display:block; font-size:11.5px; opacity:.55; }
      .sonekropp { display:none; padding:0 10px 10px; }
      .sone.apen .sonekropp { display:block; }
      .fakta { display:flex; flex-wrap:wrap; gap:6px; font-size:12px; opacity:.75;
        padding-bottom:6px; max-width:100%; }
      .fakta span:not(.badge) { background: rgba(128,128,128,.16); padding:3px 9px; border-radius:75px; }

      .stepper { display:flex; align-items:center; gap:2px; background: rgba(128,128,128,.16);
        border-radius:75px; padding:2px; }
      .steg { width:32px; height:32px; border-radius:50%; display:flex; align-items:center;
        justify-content:center; font-size:19px; cursor:pointer; user-select:none;
        background: rgba(128,128,128,.18); }
      .steg:active { transform: scale(.93); }
      .stegverdi { min-width:74px; text-align:center; font-size:14.5px; font-weight:600;
        font-variant-numeric:tabular-nums; }
      .stepper.mangler { opacity:.35; pointer-events:none; }

      .ovblokk { border-top:1px solid rgba(128,128,128,.16); margin-top:6px; padding-top:8px; }
      .undertittel { font-size:12.5px; font-weight:600; opacity:.55; padding-bottom:6px; }
      .heronavn, .heroforklaring, .herolinje { min-width:0; overflow-wrap:anywhere; }
      .herotekst { min-width:0; }
      .tall b { overflow-wrap:anywhere; }
      .ovrad { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
      .ovverdi { min-width:50px; text-align:center; font-size:15px; font-weight:600;
        font-variant-numeric:tabular-nums; }
      .knapp { padding:8px 14px; border-radius:75px; font-size:13px; cursor:pointer;
        background: rgba(128,128,128,.18); }
      .knapp.rod { background: rgba(244,67,54,.22); }

      .bryter { width:46px; height:28px; min-width:46px; border-radius:75px; cursor:pointer;
        position:relative; background: rgba(128,128,128,.28); transition: background .18s; }
      .bryter.on { background: var(--active-big, var(--primary-color)); }
      .bryter span { position:absolute; top:3px; left:3px; width:22px; height:22px;
        border-radius:50%; background:#fff; transition: transform .18s; }
      .bryter.on span { transform: translateX(18px); }
      .bryter.mangler { opacity:.3; pointer-events:none; }

      .tid, .tekst { font-family:inherit; font-size:14.5px; font-weight:600;
        color: var(--gray1000, var(--primary-text-color)); background: rgba(128,128,128,.16);
        border:none; border-radius:75px; padding:9px 14px; text-align:center; }
      .tekst { width:100%; box-sizing:border-box; text-align:left; border-radius:16px; font-weight:400; }

      .graf { position:relative; height:96px; margin:4px 0 2px; }
      .graf svg { width:100%; height:90px; }
      .graf polyline { fill:none; stroke-width:2; vector-effect:non-scaling-stroke; }
      .graf .l1 { stroke: var(--active-big, var(--primary-color)); }
      .graf .l2 { stroke: var(--orange, #fc6d09); }
      .graf .grense { stroke: var(--red, #f44336); stroke-width:1; stroke-dasharray:4 4;
        vector-effect:non-scaling-stroke; }
      .grafakse { position:absolute; top:0; right:2px; height:90px; display:flex;
        flex-direction:column; justify-content:space-between; font-size:10.5px; opacity:.45; }
      .grafvent { display:flex; align-items:center; justify-content:center; height:90px;
        font-size:12.5px; opacity:.5; text-align:center; padding:0 12px;
        overflow-wrap:anywhere; line-height:1.4; }
      .tegnforklaring { display:flex; flex-wrap:wrap; gap:6px 14px; font-size:12px; opacity:.6; padding-top:4px; }
      .tegnforklaring i { display:inline-block; width:12px; height:3px; border-radius:2px;
        margin-right:5px; vertical-align:middle; }
      .tegnforklaring .l1 { background: var(--active-big, var(--primary-color)); }
      .tegnforklaring .l2 { background: var(--orange, #fc6d09); }

      .hurtig { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:12px; }
      .mini { text-align:center; padding:11px 8px; border-radius:75px; font-size:13px;
        cursor:pointer; background: rgba(128,128,128,.16); }

      .logg { padding:10px 2px; }
      .logg + .logg { border-top:1px solid rgba(128,128,128,.14); }
      .loggtopp { display:flex; align-items:center; gap:8px; font-size:12px; }
      .loggtid { font-weight:600; font-variant-numeric:tabular-nums; }
      .loggtall { margin-left:auto; opacity:.6; font-variant-numeric:tabular-nums; }
      .loggtekst { font-size:13px; opacity:.8; margin-top:4px; line-height:1.4;
        overflow-wrap:anywhere; }
      .tiltak { margin:6px 0 0; padding-left:18px; font-size:12.5px; opacity:.62;
        line-height:1.45; overflow-wrap:anywhere; }

      @media (prefers-reduced-motion: reduce) { * { transition:none !important; } }
      @media (max-width: 400px) {
        .hero { grid-template-columns:78px 1fr; gap:10px; padding:12px; }
        .steg { width:28px; height:28px; font-size:17px; }
        .stegverdi { min-width:56px; font-size:13.5px; }
        .ring, .ring svg { width:74px; height:74px; }
        .fane span { display:none; }
        .fane { flex:1; padding:10px 8px; }
        .rutenett { grid-template-columns:1fr; }
      }
    `;
  }
}

customElements.define("ki-klima-pro-card", KiKlimaProCard);

/* ------------------------------------------------------------------ */

class KiKlimaProCardEditor extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }); }
  setConfig(config) {
    this._config = Object.assign({ default_tab: "oversikt", remember_tab: true }, config || {});
    this._tegn();
  }
  set hass(hass) { this._hass = hass; if (this._form) this._form.hass = hass; }
  _tegn() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.schema = [
        { name: "title", selector: { text: {} } },
        { name: "default_tab", selector: { select: { mode: "dropdown", options:
          FANER.map((f) => ({ value: f.id, label: f.navn })) } } },
        { name: "remember_tab", selector: { boolean: {} } },
      ];
      this._form.computeLabel = (s) => ({ title: "Tittel (valgfri)",
        default_tab: "Standardfane", remember_tab: "Husk valgt fane" }[s.name] || s.name);
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: Object.assign({}, this._config, ev.detail.value) },
          bubbles: true, composed: true }));
      });
      this.shadowRoot.appendChild(this._form);
    }
    this._form.data = this._config;
    if (this._hass) this._form.hass = this._hass;
  }
}

customElements.define("ki-klima-pro-card-editor", KiKlimaProCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ki-klima-pro-card",
  name: "KI Klima Pro",
  description: "Hele klima- og energisystemet: status, soner, energi, varmtvann, motorens resonnement og logg",
  preview: true,
});
