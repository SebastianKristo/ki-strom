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

const KI_PRO_VERSJON = "2.1.0";

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
const HJELP = {
  venter_svar: "Søndag morgen spør systemet om dere kommer hjem. Fram til du svarer, eller til svarfristen går ut, står dette på «Ja». Svarer du ikke, avsluttes helgemodus automatisk ved fristen, slik at huset er varmt når dere kommer.",
  beredskap: "En sjekk før du lar motoren overta: at den rapporterer status, at den har funnet en timesmåler, at tidskonstantene har nok målinger bak seg, og at ingen ovner står avslått. «Lærer fortsatt» betyr at den fungerer, men at nattsenkingsvurderingene ennå bygger på standardverdier.",
  skyggemodus: "Motoren regner ut alt og skriver til loggen, men rører ingen ovner. Slik kan du lese beslutningene i noen uker og se om du er enig før huset merker dem. Varmtvann, håndklevarmer og gardiner styres uansett.",
  dynamisk_grense: "Nettleien faktureres etter snittet av månedens tre høyeste timer, ikke etter den enkelte timen. Derfor regnes det ut hvor mye DENNE timen kan bruke uten at det snittet passerer målet. Tidlig i måneden gir det romslig grense, sent i måneden strammer den seg til av seg selv.",
  tillatt_effekt: "Gjenstående kWh delt på gjenstående tid av timen. Verdien er kuttet ved timegrensen og regner aldri med mindre enn et kvarter igjen — ellers ville de siste minuttene av en rolig time gitt et vanvittig høyt tall som ovnene uansett ikke rekker å bruke.",
  uregulert: "Alt huset bruker som motoren ikke styrer: komfyr, oppvaskmaskin, elektronikk, lading. Regnes som total effekt minus summen av det den styrer. Dette er grunnlaget for hele prognosen.",
  tidskonstant: "Hvor lenge rommet holder på overtemperaturen sin. Måles ved å se hvor fort det kjøles ned når varmen er av. Lang tidskonstant betyr at nattsenking sjelden lønner seg, fordi gjenoppvarmingen skjer til dyrere dagtariff.",
  komfortvekt: "Hvor tungt et temperaturavvik veier mot prioriteten når budsjettet fordeles. Høyt tall gjør at et kaldt rom med lav prioritet likevel går foran et rom som allerede er varmt.",
  shed: "Hvor mange grader motoren får senke når budsjettet ikke strekker til. Gulvvarme tåler mer enn panelovner, fordi tregheten gjør at det ikke merkes i rommet på kort sikt.",
  vvb_terskel: "Hvor mange watt som må til før en oppvarming regnes som reell. Står den for lavt, telles standby som en fullført syklus, og legionellasikringen blir bekreftet på falskt grunnlag.",
  vvb_billige: "Marginalprisen er energipris pluss energiledd. Under Norgespris er energiprisen flat, så det er bare nettleiens dag- og nattskille som skiller timene — rangeringen faller derfor naturlig ned på natt og helg.",
  vvb_syklus: "Berederen har ingen temperatursensor, men den har en termostat. Når bryteren står på og effekten faller til null, har termostaten koblet ut fordi vannet har nådd settpunktet. Det kalles metning, og er en direkte måling av at berederen er ferdig — også for legionella, forutsatt at termostaten fysisk står på 65–70 grader. Et ødelagt element gir samme signatur, så systemet krever at den HAR trukket effekt først. Har den aldri gjort det, er det en feil og ikke metning.",
  gardiner: "I fyringssesongen lukkes gardinene når sola er nede for å begrense varmetapet gjennom glassveggen, og åpnes på dagen for gratis solvarme. Er det bitende kaldt holdes de lukket også på dagen. Utenfor sesongen styres de bare i sommermodus, da som solskjerming.",
  handkle: "Klimastyringen eier denne bryteren. Når «KI styrer» er av, slås håndklevarmeren på igjen automatisk hver gang den går av — den er da ment å stå på konstant. Slå på KI-styring for å bruke tidsvinduene i stedet.",
  overtakelse: "Motoren er den eneste som skriver til ovnene. Bryteren er det motsatte av skyggemodus: på betyr at den faktisk setter settpunkt, av betyr at den bare regner og logger. Soner med «KI styrer» av røres aldri uansett.",
  lagring: "Innlærte lastprofiler, tidskonstanter, overstyringer og beslutningslogg lagres i Home Assistants .storage-mappe og overlever omstart og oppdatering av integrasjonen.",
  malekilde: "Forbruk denne timen måles direkte mot strømmålerens energiregister — motoren husker verdien ved timeskiftet og trekker fra. Svarer ikke registeret, brukes et anslag fra øyeblikkseffekt, som er merkbart mindre presist.",
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
      if (aktiv && (aktiv.tagName === "INPUT" || aktiv.tagName === "TEXTAREA")) { this._ventTegn = true; return; }
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
      "sensor.ki_bereder", "sensor.ki_hanklevarmer", "sensor.ki_gardiner",
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
      "input_datetime.ki_helg_varsel_tid", "input_datetime.ki_helg_sporsmal_tid",
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
    if (["oversikt", "energi"].includes(this._fane)) this._hentHistorikk();
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
            ${skygge ? '<span class="merke">skygge</span>' : ""}</div>
          <div class="heroforklaring">${esc(forklaring)}</div>
          <div class="herolinje">
            <span>${esc(this._s("sensor.ki_klima_status", "Klima ukjent"))}</span>
            ${isFinite(ute) ? `<span><ha-icon icon="mdi:thermometer"></ha-icon>${nf(ute, 1)}°</span>` : ""}
          </div>
        </div>
      </div>`;
  }

  /* ---------------------------- Oversikt ---------------------- */

  _oversikt() {
    const a = (n, d) => this._a("sensor.ki_energi_status", n, d);
    const modus = [
      ["input_boolean.ki_helgemodus", "Helgemodus", "mdi:bag-suitcase", true],
      ["input_boolean.ki_sommermodus", "Sommermodus", "mdi:white-balance-sunny", true],
      ["input_boolean.ki_hjemkomst_aktiv", "Hjemkomst", "mdi:home-import-outline", true],
      ["input_boolean.ki_sebastian_ferie", "Ferie", "mdi:school-outline", true],
      ["binary_sensor.ki_alle_borte", "Alle borte", "mdi:home-export-outline", false],
    ];
    const prog = (n) => nf(Number(this._a("sensor.ki_prognose", n, NaN)), 1);
    const progTekst = this._a("sensor.ki_prognose", "forklaring", "");
    const senkede = (this._a("sensor.ki_laster", "laster", []) || [])
      .filter((l) => l.handling === "senket");

    return `
      ${this._overtakelse(true)}
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
              <span>${nf(l.effekt, 2)} kW</span>
            </div>
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

  _stepperRad(entity, navn, dec, enhet) {
    const st = this._st(entity);
    return `<div class="rad">
      <div class="radtekst"><div class="radnavn">${esc(navn)}</div></div>
      <div class="stepper ${st ? "" : "mangler"}">
        <div class="steg" data-handling="tall" data-entity="${entity}" data-dir="-1">−</div>
        <div class="stegverdi">${st ? nf(st.state, dec) + enhet : "–"}</div>
        <div class="steg" data-handling="tall" data-entity="${entity}" data-dir="1">+</div>
      </div></div>`;
  }

  _tidRad(entity, navn) {
    const st = this._st(entity);
    return `<div class="rad">
      <div class="radtekst"><div class="radnavn">${esc(navn)}</div></div>
      <input class="tid" type="time" data-entity="${entity}" value="${st ? String(st.state).slice(0, 5) : ""}">
    </div>`;
  }

  /* ---------------------------- Energi ------------------------ */

  _energi() {
    const t = ["sensor.nettleie_elvia_toppforbruk", "sensor.nettleie_elvia_toppforbruk_2",
               "sensor.nettleie_elvia_toppforbruk_3"].map((id) => this._n(id));
    const snitt = t.every(isFinite) ? (t[0] + t[1] + t[2]) / 3 : NaN;
    const mal = this._n("input_number.ki_mal_snitt_kwh");
    const grunn = this._a("sensor.ki_energi_status", "grense_grunn", "");
    const grense = Number(this._a("sensor.ki_energi_status", "grense_kwh", NaN));

    return `
      <div class="blokk">
        <div class="hode"><span>Dynamisk grense${this._hj("dynamisk_grense")}</span><span class="sub">${esc(this._s("sensor.nettleie_elvia_kapasitetstrinn"))}</span></div>
        ${this._hjTekst("dynamisk_grense")}
        <div class="stor">${nf(grense, 2)} <small>kWh denne timen</small></div>
        <div class="notat">${esc(grunn)}</div>
        <div class="tallrad" style="margin-top:12px">
          ${t.map((v, i) => `<div class="tall"><b>${nf(v, 2)}</b><span>topp ${i + 1}</span></div>`).join("")}
        </div>
        <div class="under"><span>Snitt ${nf(snitt, 2)} kWh — dette faktureres</span>
          <span>Mål ${nf(mal, 2)} kWh</span></div>
        <div class="spor2" style="margin-top:8px">
          <div class="fyll2" style="width:${isFinite(snitt) && isFinite(mal) && mal > 0 ? Math.min(100, (snitt / mal) * 100) : 0}%"></div>
        </div>
      </div>
      <div class="blokk">
        <div class="hode"><span>Effekt siste 6 timer</span><span class="sub">Uregulert mot styrt</span></div>
        <div id="graf-effekt" class="graf">${this._grafPlassholder()}</div>
        <div class="tegnforklaring">
          <span><i class="l1"></i>Uregulert</span><span><i class="l2"></i>Styrt varme</span>
        </div>
      </div>
      <div class="blokk">
        <div class="hode"><span>Grenser${this._hj("shed")}${this._hj("komfortvekt")}</span></div>
        ${this._stepperRad("input_number.ki_maks_time_kwh", "Hard timegrense", 2, " kWh")}
        ${this._stepperRad("input_number.ki_mal_snitt_kwh", "Mål for snitt av tre topper", 2, " kWh")}
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
        ${this._stepperRad("input_number.ki_trinn_kostnad_diff", "Kostnad neste trinn", 0, " kr")}
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
          <div class="radverdi">${this._dato(a("siste_syklus", null))}</div>
        </div>
        <div class="rad rad-les">
          <div class="prikk p-${forfalt ? "feil" : "noytral"}"></div>
          <div class="radtekst"><div class="radnavn">Neste frist</div>
            <div class="radsub">Etter dette tvinges berederen på uansett pris</div></div>
          <div class="radverdi">${this._dato(a("neste_frist", null))}</div>
        </div>
        <div class="tallrad" style="margin-top:8px">
          <div class="tall"><b>${nf(reservert, 2)}</b><span>kW reservert</span></div>
          <div class="tall"><b>${nf(this._n("sensor.ki_vvb_oppvarming_minutter"), 0)}</b><span>min varmet</span></div>
          <div class="tall"><b>${this._pa("binary_sensor.ki_vvb_mettet") ? "Ja" : "Nei"}</b><span>mettet nå</span></div>
        </div>
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
        </div>
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
        <div class="fakta" style="padding:4px 0 10px">
          ${timer.length ? timer.map((h) => `<span class="badge ${h === new Date().getHours() ? "b-ok" : ""}">${String(h).padStart(2, "0")}</span>`).join("")
            : '<span class="badge">ingen timer valgt</span>'}
        </div>
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
        <div class="rad">
          <div class="radtekst"><div class="radnavn">Følg spotpris</div>
            <div class="radsub">Bare aktuelt uten Norgespris. Ellers brukes vinduet.</div></div>
          <div class="bryter ${this._pa("input_boolean.ki_vvb_folg_spotpris") ? "on" : ""}"
               data-handling="veksle" data-entity="input_boolean.ki_vvb_folg_spotpris"><span></span></div>
        </div>
        <div class="rad">
          <div class="radtekst"><div class="radnavn">Alltid på</div>
            <div class="radsub">Overstyrer automatikken helt</div></div>
          <div class="bryter ${this._pa("input_boolean.ki_vvb_alltid_pa") ? "on" : ""}"
               data-handling="veksle" data-entity="input_boolean.ki_vvb_alltid_pa"><span></span></div>
        </div>
      </div>
      <div class="blokk">
        <div class="hode"><span>Handling</span></div>
        <div class="hurtig">
          <div class="mini" data-handling="tjeneste" data-domene="script" data-tjeneste="${boost ? "ki_vvb_avbryt_boost" : "ki_vvb_boost"}">${boost ? "Avbryt boost" : "Boost nå"}</div>
          <div class="mini" data-handling="tjeneste" data-domene="script" data-tjeneste="ki_vvb_tving_syklus_na">Tving syklus nå</div>
        </div>
        <div class="notat">
          Berederen har ingen temperatursensor. Systemet bekrefter legionellasikring ved å
          se et fullført på→av-forløp, som betyr at termostaten nådde settpunktet. Det
          forutsetter at termostaten fysisk står på 65–70 °C — det kan ikke Home Assistant
          kontrollere. Energimotoren skriver aldri til berederen; den reserverer bare effekt.
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
            <div class="radtekst"><div class="radnavn">${esc(l.navn)} <span class="badge b-${h.k}">${esc(h.tekst)}</span></div>
              <div class="radsub">${esc(l.forklaring || "")}</div></div>
            <div class="radverdi">${nf(l.effekt, 2)} kW</div></div>`;
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
    const brytere = [
      ["input_boolean.ki_energi_hovedbryter", "Energimotor", "Hovedbryter for hele integrasjonen"],
      ["input_boolean.ki_skyggemodus", "Skyggemodus", "Regner og logger, styrer ingenting", "skyggemodus"],
      ["input_boolean.ki_dynamisk_grense", "Dynamisk grense", "Regner mot snittet av tre topper"],
      ["input_boolean.ki_prediktiv_forvarming", "Prediktiv forvarming", "Starter ut fra målt oppvarmingsrate"],
      ["input_boolean.ki_laering_tau", "Lær tidskonstanter", ""],
      ["input_boolean.ki_solkompensasjon", "Solkompensasjon", "Trekker fra solvarme i stua"],
      ["input_boolean.ki_nattsenk_aktiv", "Nattsenking", "Av = ingen soner senkes om natten"],
      ["input_boolean.ki_nattsenk_okonomi", "Økonomisk nattsenking", "Senker bare når sparingen slår gjenoppvarmingen"],
      ["input_boolean.ki_energi_varsler", "Energivarsler", ""],
      ["input_boolean.ki_helg_auto", "Helg automatisk ved fravær", "Torsdag/fredag etter lengre fravær"],
      ["input_boolean.ki_helg_senk_gulvvarme", "Helg senk gulvvarme", ""],
      ["input_boolean.ki_sommer_auto", "Sommermodus automatisk", "Etter måned og utetemperatur"],
      ["input_boolean.ki_vvb_legionella_aktiv", "Legionellasikring", "Kan ikke blokkeres av sparing når den er på"],
      ["input_boolean.ki_styr_gardiner", "Styr gardiner", ""],
      ["input_boolean.ki_styr_hanklevarmer", "Styr håndklevarmer", ""],
      ["input_boolean.ki_vvb_prisstyring", "VVB prisstyring", "Velger de billigste timene"],
      ["input_boolean.ki_vvb_alltid_pa", "VVB alltid på", "Kobler ut prisstyringen"],
    ];
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
      <div class="blokk">
        <div class="hode"><span>Brytere</span></div>
        ${brytere.map(([id, navn, sub, hjelp]) => {
          const st = this._st(id);
          return `<div class="rad">
            <div class="radtekst"><div class="radnavn">${esc(navn)}${st ? "" : ' <span class="merke">mangler</span>'}${hjelp ? this._hj(hjelp) : ""}</div>
              ${sub ? `<div class="radsub">${esc(sub)}</div>` : ""}</div>
            <div class="bryter ${st && st.state === "on" ? "on" : ""} ${st ? "" : "mangler"}"
                 data-handling="veksle" data-entity="${id}"><span></span></div>
          </div>${hjelp ? this._hjTekst(hjelp) : ""}`;
        }).join("")}
      </div>
      <div class="blokk">
        <div class="hode"><span>Tider</span></div>
        ${this._tidRad("input_datetime.ki_tid_dag_start", "Dag starter")}
        ${this._tidRad("input_datetime.ki_tid_natt_start", "Natt starter")}
        ${this._tidRad("input_datetime.ki_cybele_dag", "Cybele dag")}
        ${this._tidRad("input_datetime.ki_cybele_natt", "Cybele natt")}
        ${this._tidRad("input_datetime.ki_sebastian_vekking", "Sebastian vekking")}
        ${this._tidRad("input_datetime.ki_sebastian_vekking_helg", "Vekking helg")}
        ${this._tidRad("input_datetime.ki_sebastian_natt", "Sebastian natt")}
        ${this._tidRad("input_datetime.ki_cybele_borte_fra", "Cybele borte fra")}
        ${this._tidRad("input_datetime.ki_cybele_borte_til", "Cybele hjemme igjen")}
        ${this._tidRad("input_datetime.ki_stue_reduksjon_fra", "Stue reduksjon fra")}
        ${this._stepperRad("input_number.ki_natt_senk_ute_grense", "Nattsenk kun under", 0, " °C")}
        ${this._stepperRad("input_number.ki_stue_reduksjon", "Stue reduksjon", 1, " °C")}
      </div>
      <div class="blokk">
        <div class="hode"><span>Varsler</span></div>
        <div class="rad">
          <div class="radtekst"><div class="radnavn">Send varsler</div>
            <div class="radsub">Mottakere velges under Innstillinger → Enheter og tjenester → KI Energi → Konfigurer → Hus og varsler</div></div>
          <div class="bryter ${this._pa("input_boolean.ki_energi_varsler") ? "on" : ""}"
               data-handling="veksle" data-entity="input_boolean.ki_energi_varsler"><span></span></div>
        </div>
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
        ${this._tidRad("input_datetime.ki_frokost_start", "Frokost fra")}
        ${this._tidRad("input_datetime.ki_frokost_slutt", "Frokost til")}
        ${this._tidRad("input_datetime.ki_middag_start", "Middag fra")}
        ${this._tidRad("input_datetime.ki_middag_slutt", "Middag til")}
        <div class="notat">Måltidsreservene brukes bare til lastprofilen har nok målinger for
          timen. Etter det vet motoren selv hva komfyren pleier å trekke.</div>
      </div>

      <div class="blokk">
        <div class="hode"><span>Moduser og unntak</span></div>
        ${this._stepperRad("input_number.ki_temp_helg", "Helgetemperatur", 1, " °C")}
        ${this._stepperRad("input_number.ki_temp_helg_gulvvarme", "Helg gulvvarme", 1, " °C")}
        ${this._stepperRad("input_number.ki_temp_helg_bad", "Helg bad", 1, " °C")}
        ${this._stepperRad("input_number.ki_temp_sommer", "Sommertemperatur", 1, " °C")}
        ${this._stepperRad("input_number.ki_sommer_start_maned", "Sommer fra måned", 0, "")}
        ${this._stepperRad("input_number.ki_sommer_slutt_maned", "Sommer til måned", 0, "")}
        ${this._stepperRad("input_number.ki_sommer_ute_grense", "Sommer når ute over", 0, " °C")}
        ${this._stepperRad("input_number.ki_helg_auto_timer", "Helg auto etter", 0, " t borte")}
        <div class="notat">Forvarming bruker motorens målte oppvarmingsrate per sone. Sonene
          starter så sent som mulig innenfor budsjettet, og gulvvarme aldri senere enn 45
          minutter før fristen.</div>
      </div>

      <div class="blokk">
        <div class="hode"><span>Helgevarsler</span><span class="sub">Fredag og søndag</span></div>
        ${this._tidRad("input_datetime.ki_helg_varsel_tid", "Spørsmål fredag")}
        ${this._tidRad("input_datetime.ki_helg_sporsmal_tid", "Spørsmål søndag")}
        ${this._tidRad("input_datetime.ki_helg_frist_tid", "Svarfrist søndag")}
        ${this._tidRad("input_datetime.ki_hjemkomst_tid", "Forventet hjemkomst")}
        <div class="hurtig">
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi" data-tjeneste="helg_sporsmal">Send spørsmålet nå</div>
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi" data-tjeneste="hjemkomst">Start hjemkomst</div>
          <div class="mini" data-handling="tjeneste" data-domene="ki_energi" data-tjeneste="hjemkomst_ferdig">Avslutt hjemkomst</div>
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
        <div class="hode"><span>Handlinger</span></div>
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
        <div class="notat">Entiteter og husets data endres under Innstillinger → Integrasjoner → KI Energi → Konfigurer.</div>
        ${this._hjTekst("standardverdier")}
        <div class="notat">Nullstilling av tidskonstanter betyr at motoren må lære huset
          på nytt, og at nattsenkingen faller tilbake på standardverdier i mellomtiden.
          Bruk det bare hvis tallene ser åpenbart feil ut.</div>
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
      const a = this._serie("sensor.ki_uregulert_effekt", 6).map((p) => ({ t: p.t, v: p.v / 1000 }));
      const b = this._serie("sensor.ki_styrt_effekt", 6).map((p) => ({ t: p.t, v: p.v / 1000 }));
      effGraf.innerHTML = (a.length || b.length)
        ? this._svg([{ punkter: a, klasse: "l1" }, { punkter: b, klasse: "l2" }], { enhet: " kW" })
        : `<div class="grafvent">Ingen historikk ennå — sensorene er nye</div>`;
    }
  }

  _svg(serier, opt = {}) {
    const B = 340, H = 90, pad = 4;
    const alle = serier.flatMap((s) => s.punkter);
    if (!alle.length) return `<div class="grafvent">Ingen data</div>`;
    const t0 = Math.min(...alle.map((p) => p.t));
    const t1 = Math.max(...alle.map((p) => p.t));
    let vMax = Math.max(...alle.map((p) => p.v), opt.grense || 0);
    const vMin = Math.min(0, ...alle.map((p) => p.v));
    if (vMax === vMin) vMax = vMin + 1;
    const x = (t) => pad + ((t - t0) / Math.max(t1 - t0, 1)) * (B - 2 * pad);
    const y = (v) => H - pad - ((v - vMin) / (vMax - vMin)) * (H - 2 * pad);

    const linjer = serier.filter((s) => s.punkter.length).map((s) =>
      `<polyline class="${s.klasse}" points="${s.punkter.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}"></polyline>`
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
    } else if (h === "mer") {
      this.dispatchEvent(new CustomEvent("hass-more-info", {
        detail: { entityId: el.dataset.entity }, bubbles: true, composed: true }));
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
      .hode { display:flex; justify-content:space-between; align-items:baseline; gap:10px;
        font-size:13px; font-weight:600; opacity:.55; padding:8px 4px; }
      .sub { font-weight:500; text-align:right; }
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
      .radverdi { font-size:13.5px; font-weight:600; opacity:.85; flex:0 1 auto;
        font-variant-numeric:tabular-nums; white-space:nowrap; text-align:right;
        overflow:hidden; text-overflow:ellipsis; max-width:55%; }
      /* Lange verdier, som råattributter og entitets-ID-er, skal brekke i
         stedet for å presse kortet ut i bredden. */
      .radverdi.brytbar { white-space:normal; overflow-wrap:anywhere;
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
      .undertittel { font-size:12px; font-weight:600; opacity:.5; padding-bottom:6px; }
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
      .tegnforklaring { display:flex; gap:14px; font-size:12px; opacity:.6; padding-top:4px; }
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
