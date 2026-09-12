<?php
/**
 * Publieke item-exchange-contracten met Jita-waardering ("koopjesjacht").
 *
 * Geen token nodig: /contracts/public/{region}/ en /contracts/public/items/{id}/
 * zijn openbaar. Iedereen ziet dus dezelfde lijst.
 *
 * De schaal is het lastige deel: The Forge heeft ~34.000 open contracten en de
 * inhoud kost één ESI-call per contract. Daarom:
 *   - alleen item_exchange binnen een prijsvenster (de rest is ruis),
 *   - de NIEUWSTE eerst waarderen (koopjes zijn snel weg),
 *   - inhoud permanent cachen (die verandert nooit),
 *   - per verzoek een harde call- en tijdslimiet, zodat de pagina snel blijft.
 * De dekking groeit dus met elk bezoek; wat nog niet gewaardeerd is telt niet mee.
 *
 *   GET ?action=list      → gewaardeerde contracten + voortgang
 *   GET ?action=scan      → alleen scannen (voor een periodieke warmer), geeft tellers
 *   GET ?action=mineralen → mineraalcontracten in de eigen regio, tegen Jita (zie onder)
 */

require_once 'config.php';
cors();

// ESI geeft publieke contracten alléén per regio, dus we halen per hub de regio op
// (daar ligt de hub in) en filteren de kandidaten meteen op het hub-station/-structure.
//
// Per hub: regio-id => [hub-naam, locatie-id, systeemnaam, volledige stationnaam].
// De hub-naam is meteen het filter dat de frontend als knop toont.
//
// De vijf grote NPC-handelshubs hebben een vast station-id + bekende stationnaam.
// BKG-Q2 en 4-HWWF zijn nullsec-systemen: daar staan contracten in een PLAYER-
// STRUCTURE (Upwell). We filteren dan op de structure-id van de handelshub, en
// laten de volledige naam leeg — die lost de frontend op met het token van de
// ingelogde gebruiker (structures kan de server niet tokenloos opzoeken).
const CD_HUBS = [
    10000002 => ['Jita',    60003760, 'Jita',    'Jita IV - Moon 4 - Caldari Navy Assembly Plant'],
    10000043 => ['Amarr',   60008494, 'Amarr',   'Amarr VIII (Oris) - Emperor Family Academy'],
    10000032 => ['Dodixie', 60011866, 'Dodixie', 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant'],
    10000030 => ['Rens',    60004588, 'Rens',    'Rens VI - Moon 8 - Brutor Tribe Treasury'],
    10000042 => ['Hek',     60005686, 'Hek',     'Hek VIII - Moon 12 - Boundless Creation Factory'],
    // nullsec — player-structure handelshubs (naam wordt frontend-side opgelost)
    10000055 => ['BKG-Q2',  1032721770598, 'BKG-Q2', ''],   // Branch
    10000003 => ['4-HWWF',  1053970513596, '4-HWWF', ''],   // Vale of the Silent
];
const CD_MIN_PRICE       = 200000000;  // 200 mln — daaronder zijn het vrijwel
                                       // alleen BPC-verkopen, en die zijn niet op
                                       // marktprijs te waarderen (gemeten: 2% bruikbaar
                                       // onder 50 mln, 45% boven 1 mrd)
const CD_MAX_PRICE       = 50000000000;// 50 mrd
const CD_MAX_KANDIDATEN  = 4000;       // nieuwste N binnen het prijsvenster
const CD_LIJST_SECONDEN  = 1800;       // contractenlijst 30 min vasthouden
const CD_PRIJS_SECONDEN  = 3600;       // marktprijzen 1 uur
const CD_ITEMS_PER_CALL  = 60;         // max contract-inhouden per verzoek
const CD_TIJD_BUDGET     = 12;         // en niet langer dan dit (PHP-limiet)
const CD_TOON            = 200;        // zoveel beste deals teruggeven (ruimer, zodat
                                       // ook de kleinere hubs in beeld komen)
const CD_JITA_4_4        = 60003760;   // waarderen doen we ALTIJD tegen Jita, ook voor
                                       // koopjes in Amarr/Dodixie/Rens/Hek
const CD_MIN_SELL_VOLUME = 20;
const CD_MAX_SELL_RATIO  = 10;

// ---------------------------------------------------------------- schema

function cdSchema(PDO $pdo): void {
    // cc_items / cc_prices / cc_cache zijn generiek en worden hergebruikt.
    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_items (
        contract_id BIGINT PRIMARY KEY,
        items LONGTEXT NOT NULL,
        fetched_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_prices (
        type_id INT PRIMARY KEY,
        name VARCHAR(150) NOT NULL DEFAULT '',
        buy DOUBLE NOT NULL DEFAULT 0,
        sell DOUBLE NOT NULL DEFAULT 0,
        sell_safe DOUBLE NOT NULL DEFAULT 0,
        thin TINYINT NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_cache (
        k VARCHAR(64) PRIMARY KEY,
        v LONGTEXT NOT NULL,
        updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_locaties (
        id BIGINT PRIMARY KEY,
        naam VARCHAR(255) NOT NULL DEFAULT '',
        systeem VARCHAR(100) NOT NULL DEFAULT '',
        updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // Namen van uitgevers (characters/corps). Publiek op te zoeken via
    // /universe/names en daarna permanent te bewaren — namen wijzigen zelden.
    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_namen (
        id BIGINT PRIMARY KEY,
        naam VARCHAR(255) NOT NULL DEFAULT '',
        updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    // Kolom kan ontbreken als de tabel van een eerdere versie is.
    try { $pdo->query('SELECT systeem FROM cc_locaties LIMIT 1'); }
    catch (Exception $e) { try { $pdo->exec("ALTER TABLE cc_locaties ADD COLUMN systeem VARCHAR(100) NOT NULL DEFAULT ''"); } catch (Exception $e2) {} }
}

/**
 * {id: stationnaam} voor de opgegeven locatie-ids.
 *
 * NPC-stations zijn publiek op te zoeken via /universe/names; de systeemnaam
 * leiden we uit die naam af (zie onder).
 * Player-structures (Upwell) hebben een token nodig, dus die laten we hier leeg
 * — de frontend vult ze aan met het token van de ingelogde gebruiker.
 */
function cdLocaties(PDO $pdo, array $ids): array {
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
    if (!$ids) return [];

    $uit = [];
    foreach (array_chunk($ids, 500) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        $st = $pdo->prepare("SELECT id, naam, systeem FROM cc_locaties WHERE id IN ($in)");
        $st->execute($chunk);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $uit[(int)$r['id']] = ['naam' => $r['naam'], 'systeem' => $r['systeem']];
        }
    }

    // Alleen stations opzoeken; structures (ids ver boven de 2^31) kan ESI
    // zonder token niet prijsgeven. Een rij mét naam maar zónder systeem is ook
    // onaf — die stond er al voordat we het systeem gingen opslaan.
    $todo = array_values(array_filter($ids, fn($i) =>
        $i < 100000000 && (!isset($uit[$i]) || ($uit[$i]['systeem'] ?? '') === '')));
    if (!$todo) return $uit;

    // Namen in bulk (één call per 500), systeem per station (die zit niet in
    // /universe/names) — beide daarna permanent gecached.
    $namen = [];
    foreach (array_chunk($todo, 500) as $chunk) {
        [$status, $body] = cdHttp('https://esi.evetech.net/latest/universe/names/?datasource=tranquility',
                                  ['Content-Type: application/json'], json_encode(array_values($chunk)));
        if ($status !== 200) continue;
        foreach ((json_decode($body, true) ?: []) as $r) {
            if (isset($r['id'], $r['name'])) $namen[(int)$r['id']] = $r['name'];
        }
    }

    // Het systeem hoeft niet apart opgevraagd te worden: een EVE-locatienaam
    // begint altijd met de systeemnaam ("Jita IV - Moon 4 - ...", "BKG-Q2 - ...")
    // en systeemnamen bevatten nooit een spatie. Dat scheelt 2 ESI-calls per
    // station — en die pasten niet in het tijdsbudget van een verzoek.
    $ins = $pdo->prepare('INSERT INTO cc_locaties (id, naam, systeem, updated_at) VALUES (?, ?, ?, NOW())
                          ON DUPLICATE KEY UPDATE naam = VALUES(naam), systeem = VALUES(systeem),
                              updated_at = NOW()');
    foreach ($todo as $id) {
        $naam = $namen[$id] ?? '';
        if ($naam === '') continue;
        $systeem = strtok($naam, ' ');
        $uit[$id] = ['naam' => $naam, 'systeem' => $systeem];
        $ins->execute([$id, $naam, $systeem]);
    }

    return $uit;
}

/**
 * {id: naam} voor uitgevers (characters én corps).
 *
 * /universe/names lost characters, corps, allianties enz. in bulk op zonder token.
 * Namen worden permanent gecached; onbekende ids (verwijderde characters) laten we
 * gewoon leeg — de frontend toont dan niets.
 */
function cdNamen(PDO $pdo, array $ids): array {
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
    if (!$ids) return [];

    $uit = [];
    foreach (array_chunk($ids, 500) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        $st = $pdo->prepare("SELECT id, naam FROM cc_namen WHERE id IN ($in)");
        $st->execute($chunk);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $uit[(int)$r['id']] = $r['naam'];
    }

    $todo = array_values(array_filter($ids, fn($i) => !isset($uit[$i])));
    if (!$todo) return $uit;

    $ins = $pdo->prepare('INSERT INTO cc_namen (id, naam, updated_at) VALUES (?, ?, NOW())
                          ON DUPLICATE KEY UPDATE naam = VALUES(naam), updated_at = NOW()');
    foreach (array_chunk($todo, 500) as $chunk) {
        [$status, $body] = cdHttp('https://esi.evetech.net/latest/universe/names/?datasource=tranquility',
                                  ['Content-Type: application/json'], json_encode(array_values($chunk)));
        if ($status !== 200) continue;   // 404 als één id onvindbaar is: hele chunk overslaan
        foreach ((json_decode($body, true) ?: []) as $r) {
            if (isset($r['id'], $r['name'])) {
                $uit[(int)$r['id']] = $r['name'];
                $ins->execute([(int)$r['id'], $r['name']]);
            }
        }
    }
    return $uit;
}

function cdCacheGet(PDO $pdo, string $key, int $maxAge): ?array {
    $st = $pdo->prepare('SELECT v, UNIX_TIMESTAMP(updated_at) AS ts FROM cc_cache WHERE k = ?');
    $st->execute([$key]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    if ($maxAge > 0 && (time() - (int)$row['ts']) > $maxAge) return null;
    $data = json_decode($row['v'], true);
    return is_array($data) ? ['data' => $data, 'ts' => (int)$row['ts']] : null;
}

function cdCacheSet(PDO $pdo, string $key, array $value): void {
    $st = $pdo->prepare('INSERT INTO cc_cache (k, v, updated_at) VALUES (?, ?, NOW())
                         ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = NOW()');
    $st->execute([$key, json_encode($value)]);
}

// ---------------------------------------------------------------- http

function cdHttp(string $url, array $headers = [], ?string $post = null): array {
    static $ch = null;
    if ($ch === null) $ch = curl_init();          // hergebruik de verbinding
    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_HTTPHEADER     => array_merge(['User-Agent: dutchlegions-dashboard (contract-deals)'], $headers),
        CURLOPT_HEADER         => true,
    ]);
    // Let op: CURLOPT_POSTFIELDS zetten maakt er sowieso een POST van, óók met
    // CURLOPT_POST => false. Bij een GET moeten we de handle dus expliciet
    // terugzetten, anders krijgt ESI een POST en antwoordt het niet.
    if ($post !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $post);
    } else {
        curl_setopt($ch, CURLOPT_HTTPGET, true);
    }
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hlen = (int)curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    if ($raw === false) return [0, '', []];
    $head = substr($raw, 0, $hlen);
    $body = substr($raw, $hlen);
    $hdrs = [];
    foreach (explode("\r\n", $head) as $regel) {
        if (strpos($regel, ':') !== false) {
            [$k, $v] = explode(':', $regel, 2);
            $hdrs[strtolower(trim($k))] = trim($v);
        }
    }
    return [$status, $body, $hdrs];
}

/** ESI-call. Geeft [gelukt, data, headers] — 'gelukt' onderscheidt leeg van mislukt. */
function cdEsi(string $path, array $params = []): array {
    $params['datasource'] = 'tranquility';
    $url = 'https://esi.evetech.net/latest' . $path . '?' . http_build_query($params);
    [$status, $body, $hdrs] = cdHttp($url);
    if ($status !== 200) return [false, null, $hdrs];
    $data = json_decode($body, true);
    return [true, is_array($data) ? $data : [], $hdrs];
}

// ---------------------------------------------------------------- prijzen

function cdUpdatePrices(PDO $pdo, array $typeIds): void {
    if (!$typeIds) return;
    $vers = [];
    $in = implode(',', array_fill(0, count($typeIds), '?'));
    $st = $pdo->prepare("SELECT type_id FROM cc_prices WHERE type_id IN ($in)
                         AND updated_at > DATE_SUB(NOW(), INTERVAL " . CD_PRIJS_SECONDEN . " SECOND)");
    $st->execute($typeIds);
    foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $t) $vers[(int)$t] = true;

    $todo = array_values(array_filter($typeIds, fn($t) => !isset($vers[(int)$t])));
    if (!$todo) return;

    $ins = $pdo->prepare('INSERT INTO cc_prices (type_id, name, buy, sell, sell_safe, thin, updated_at)
                          VALUES (?, "", ?, ?, ?, ?, NOW())
                          ON DUPLICATE KEY UPDATE buy = VALUES(buy), sell = VALUES(sell),
                              sell_safe = VALUES(sell_safe), thin = VALUES(thin), updated_at = NOW()');

    foreach (array_chunk($todo, 200) as $chunk) {
        [$status, $body] = cdHttp('https://market.fuzzwork.co.uk/aggregates/?station=' . CD_JITA_4_4
                                  . '&types=' . implode(',', $chunk));
        if ($status !== 200) continue;
        $data = json_decode($body, true);
        if (!is_array($data)) continue;
        foreach ($data as $typeId => $row) {
            $buy        = (float)($row['buy']['percentile'] ?? 0);
            $sell       = (float)($row['sell']['percentile'] ?? 0);
            $sellVolume = (float)($row['sell']['volume'] ?? 0);
            // Eén gekke order kan een waardering verzieken; het bod is het ijkpunt.
            $thin = $buy > 0
                ? ($sell > 0 && $sell > $buy * CD_MAX_SELL_RATIO)
                : ($sell > 0 && $sellVolume < CD_MIN_SELL_VOLUME);
            $ins->execute([(int)$typeId, $buy, $sell, ($thin && $buy > 0) ? $buy : $sell, $thin ? 1 : 0]);
        }
    }
}

function cdUpdateNames(PDO $pdo, array $typeIds): void {
    if (!$typeIds) return;
    $in = implode(',', array_fill(0, count($typeIds), '?'));
    $st = $pdo->prepare("SELECT type_id FROM cc_prices WHERE type_id IN ($in) AND name = ''");
    $st->execute($typeIds);
    $todo = array_map('intval', $st->fetchAll(PDO::FETCH_COLUMN));
    if (!$todo) return;
    $upd = $pdo->prepare('UPDATE cc_prices SET name = ? WHERE type_id = ?');
    foreach (array_chunk($todo, 500) as $chunk) {
        [$status, $body] = cdHttp('https://esi.evetech.net/latest/universe/names/?datasource=tranquility',
                                  ['Content-Type: application/json'], json_encode(array_values($chunk)));
        if ($status !== 200) continue;
        foreach ((json_decode($body, true) ?: []) as $row) {
            if (isset($row['id'], $row['name'])) $upd->execute([$row['name'], (int)$row['id']]);
        }
    }
}

// ---------------------------------------------------------------- contracten

/**
 * Alle openbare contracten van één regio (alle pagina's, binnen het tijdsbudget).
 * Geeft null als de eerste pagina al mislukt — dan valt de aanroeper terug op
 * z'n oude cache.
 */
function cdRegioContracten(int $regioId): ?array {
    [$ok, $eerste, $hdrs] = cdEsi("/contracts/public/{$regioId}/", ['page' => 1]);
    if (!$ok) return null;
    $paginas = max(1, (int)($hdrs['x-pages'] ?? 1));
    $alles = $eerste;

    $start = time();
    for ($p = 2; $p <= $paginas; $p++) {
        if (time() - $start > CD_TIJD_BUDGET) break;   // rest volgt bij een volgende ronde
        [$ok2, $rows] = cdEsi("/contracts/public/{$regioId}/", ['page' => $p]);
        if (!$ok2 || !$rows) break;
        $alles = array_merge($alles, $rows);
    }
    return $alles;
}

/** Kandidaten van één hub ophalen (of uit de cache halen). */
function cdRegioKandidaten(PDO $pdo, int $regioId, bool $force = false): array {
    [$hubNaam, $stationId] = CD_HUBS[$regioId];
    $key = 'cd_lijst_' . $regioId;
    $cache = $force ? null : cdCacheGet($pdo, $key, CD_LIJST_SECONDEN);
    if ($cache) return $cache['data'];

    $alles = cdRegioContracten($regioId);
    if ($alles === null) {
        $oud = cdCacheGet($pdo, $key, 0);
        return $oud ? $oud['data'] : [];
    }

    $kandidaten = [];
    foreach ($alles as $c) {
        if (($c['type'] ?? '') !== 'item_exchange') continue;
        // Alleen contracten op het hub-station zelf — de rest van de regio valt
        // hiermee weg zonder één extra ESI-call.
        if ((int)($c['start_location_id'] ?? 0) !== $stationId) continue;
        $prijs = (float)($c['price'] ?? 0);
        if ($prijs < CD_MIN_PRICE || $prijs > CD_MAX_PRICE) continue;
        $kandidaten[] = [
            'id'         => (int)$c['contract_id'],
            'prijs'      => $prijs,
            'beloning'   => (float)($c['reward'] ?? 0),
            'volume'     => (float)($c['volume'] ?? 0),
            'titel'      => (string)($c['title'] ?? ''),
            'uitgegeven' => (string)($c['date_issued'] ?? ''),
            'verlooptOp' => (string)($c['date_expired'] ?? ''),
            'locatieId'  => (int)($c['start_location_id'] ?? 0),
            'issuerId'   => (int)($c['issuer_id'] ?? 0),
            'issuerCorpId' => (int)($c['issuer_corporation_id'] ?? 0),
            'forCorp'    => !empty($c['for_corporation']),
            'regioId'    => $regioId,
            'regio'      => $hubNaam,
        ];
    }
    usort($kandidaten, fn($a, $b) => strcmp($b['uitgegeven'], $a['uitgegeven']));
    $kandidaten = array_slice($kandidaten, 0, CD_MAX_KANDIDATEN);

    cdCacheSet($pdo, $key, $kandidaten);
    return $kandidaten;
}

/**
 * Alle kandidaten uit alle hubs, nieuwste eerst.
 *
 * Elke hub heeft z'n eigen cache; per verzoek verversen we er hooguit één
 * (de oudste), zodat een verzoek nooit alle hubs tegelijk hoeft op te halen.
 */
function cdKandidaten(PDO $pdo, bool $force = false): array {
    // Kies precies één hub om te verversen: de oudste. Normaal alleen als die
    // ouder is dan 30 min; bij een handmatige refresh negeren we die gate zodat
    // er sowieso één ververst. NOOIT meer dan één per verzoek — 5 hubs tegelijk
    // ophalen zou het PHP-tijdsbudget overschrijden.
    $verversen = null;
    $oudste = PHP_INT_MAX;
    foreach (CD_HUBS as $rid => $hub) {
        $c = cdCacheGet($pdo, 'cd_lijst_' . $rid, 0);
        $ts = $c ? $c['ts'] : 0;                           // nooit opgehaald = hoogste prioriteit
        if (($force || time() - $ts > CD_LIJST_SECONDEN) && $ts < $oudste) { $oudste = $ts; $verversen = $rid; }
    }

    $alles = [];
    foreach (CD_HUBS as $rid => $hub) {
        $alles = array_merge($alles, cdRegioKandidaten($pdo, $rid, $verversen === $rid));
    }
    usort($alles, fn($a, $b) => strcmp($b['uitgegeven'], $a['uitgegeven']));
    return $alles;
}

/** Inhoud ophalen voor contracten die we nog niet kennen (binnen budget). */
function cdScan(PDO $pdo, array $kandidaten): array {
    $ids = array_column($kandidaten, 'id');
    $bekend = [];
    foreach (array_chunk($ids, 500) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        $st = $pdo->prepare("SELECT contract_id FROM cc_items WHERE contract_id IN ($in)");
        $st->execute($chunk);
        foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $cid) $bekend[(int)$cid] = true;
    }

    $todo = array_values(array_filter($ids, fn($id) => !isset($bekend[$id])));
    $ins = $pdo->prepare('INSERT INTO cc_items (contract_id, items, fetched_at) VALUES (?, ?, NOW())
                          ON DUPLICATE KEY UPDATE items = VALUES(items), fetched_at = NOW()');

    $start = time();
    $gedaan = 0;
    foreach ($todo as $cid) {
        if ($gedaan >= CD_ITEMS_PER_CALL || (time() - $start) > CD_TIJD_BUDGET) break;
        [$ok, $items] = cdEsi("/contracts/public/items/{$cid}/");
        $gedaan++;
        if (!$ok) continue;                      // mislukt ≠ leeg: niet opslaan
        $ins->execute([$cid, json_encode($items ?: [])]);
    }
    return ['gescand' => $gedaan, 'nog_te_gaan' => max(0, count($todo) - $gedaan), 'bekend' => count($bekend)];
}

/**
 * Set van alle ship-type_ids (voor de "gefit schip"-herkenning).
 *
 * ships.json = {scheepsnaam: typeId}; we hebben alleen de type_ids nodig als
 * snelle lookup. Eenmaal per verzoek geladen.
 */
function cdShipSet(): array {
    static $set = null;
    if ($set !== null) return $set;
    $set = [];
    $ruw = @file_get_contents(__DIR__ . '/../ships.json');
    if ($ruw !== false) {
        $data = json_decode($ruw, true);
        if (is_array($data)) $set = array_flip(array_map('intval', array_values($data)));
    }
    return $set;   // {typeId: index} → isset($set[$tid]) = is een schip
}

/** Waardeer alles wat we in de cache hebben en geef de beste deals terug. */
function cdWaardeer(PDO $pdo, array $kandidaten): array {
    $schepenSet = cdShipSet();
    $ids = array_column($kandidaten, 'id');
    $inhoud = [];
    foreach (array_chunk($ids, 500) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        $st = $pdo->prepare("SELECT contract_id, items FROM cc_items WHERE contract_id IN ($in)");
        $st->execute($chunk);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $inhoud[(int)$r['contract_id']] = json_decode($r['items'], true) ?: [];
        }
    }

    $typeIds = [];
    foreach ($inhoud as $items) {
        foreach ($items as $i) if (!empty($i['type_id'])) $typeIds[(int)$i['type_id']] = true;
    }
    $typeIds = array_keys($typeIds);
    cdUpdatePrices($pdo, $typeIds);
    cdUpdateNames($pdo, $typeIds);

    $prijzen = [];
    foreach (array_chunk($typeIds, 500) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        $st = $pdo->prepare("SELECT * FROM cc_prices WHERE type_id IN ($in)");
        $st->execute($chunk);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $prijzen[(int)$r['type_id']] = $r;
    }

    $rijen = [];
    foreach ($kandidaten as $k) {
        if (!isset($inhoud[$k['id']])) continue;      // nog niet gescand
        $items = $inhoud[$k['id']];
        if (!$items) continue;                        // leeg contract: niets te waarderen

        $waardeSell = 0.0; $waardeBuy = 0.0; $kostenGeef = 0.0;
        $dun = false; $bpc = false; $prijsOnbekend = false;
        $heeftSchip = false; $heeftInlever = false;
        $regels = [];

        foreach ($items as $i) {
            $tid    = (int)($i['type_id'] ?? 0);
            $aantal = (int)($i['quantity'] ?? 0);
            $p      = $prijzen[$tid] ?? null;
            $isBpc  = !empty($i['is_blueprint_copy']);
            if ($isBpc) $bpc = true;
            if ($p && !empty($p['thin'])) $dun = true;
            if (isset($schepenSet[$tid])) $heeftSchip = true;   // contract bevat een schip

            // Een BPC is niet hetzelfde product als het originele blueprint —
            // op typeprijs waarderen zou er volledig naast zitten.
            $buy  = $isBpc ? 0.0 : (float)($p['buy'] ?? 0);
            $sell = $isBpc ? 0.0 : (float)($p['sell_safe'] ?? 0);
            if (!$isBpc && !$sell) $prijsOnbekend = true;

            if (!empty($i['is_included'])) {
                $waardeSell += $sell * $aantal;
                $waardeBuy  += $buy  * $aantal;
                $regels[] = ['typeId' => $tid, 'naam' => $p['name'] ?? ('#' . $tid),
                             'aantal' => $aantal, 'isBpc' => $isBpc, 'waarde' => $sell * $aantal];
            } else {
                $kostenGeef += $sell * $aantal;      // dit moet je zelf inleveren
                $heeftInlever = true;
            }
        }
        usort($regels, fn($a, $b) => $b['waarde'] <=> $a['waarde']);

        $betaalt   = $k['prijs'] + $kostenGeef;
        $nettoSell = $waardeSell + $k['beloning'] - $betaalt;
        $nettoBuy  = $waardeBuy  + $k['beloning'] - $betaalt;

        $rijen[] = $k + [
            'betaalt'    => $betaalt,
            'waardeSell' => $waardeSell,
            'waardeBuy'  => $waardeBuy,
            'nettoSell'  => $nettoSell,
            'nettoBuy'   => $nettoBuy,
            'marge'      => $betaalt > 0 ? ($nettoSell / $betaalt * 100) : null,
            'items'      => array_slice($regels, 0, 6),
            'aantalItems'=> count($regels),
            'dunneMarkt' => $dun,
            'heeftBpc'   => $bpc,
            'prijsOnbekend' => $prijsOnbekend,
            // Een gefit schip = een schip mét meerdere modules (ship + fit); die zijn
            // lastiger door te verkopen dan losse items.
            'gefitSchip' => $heeftSchip && count($regels) >= 4,
            'heeftSchip' => $heeftSchip,
            'heeftInlever' => $heeftInlever,
            'onbekend'   => false,
            'leeg'       => false,
        ];
    }

    usort($rijen, fn($a, $b) => $b['nettoSell'] <=> $a['nettoSell']);

    // Uitgevernamen erbij (alleen voor wat we tonen — scheelt lookups). De locatie
    // hoeven we niet meer op te zoeken: elk contract ligt op het hub-station van
    // z'n regio, dus stationnaam + systeem komen rechtstreeks uit CD_HUBS.
    $tonen = array_slice($rijen, 0, CD_TOON);
    // Zowel de speler als (bij corp-contracten) de corp opzoeken in één call.
    $naamIds = [];
    foreach ($tonen as $r) {
        if (!empty($r['issuerId']))     $naamIds[] = $r['issuerId'];
        if (!empty($r['forCorp']) && !empty($r['issuerCorpId'])) $naamIds[] = $r['issuerCorpId'];
    }
    $namen = cdNamen($pdo, $naamIds);
    foreach ($rijen as &$r) {
        $hub = CD_HUBS[$r['regioId']] ?? null;
        $r['locatie'] = $hub[3] ?? '';   // volledige stationnaam
        $r['systeem'] = $hub[2] ?? '';   // systeemnaam
        $r['issuer']     = $namen[$r['issuerId']] ?? '';
        $r['issuerCorp'] = !empty($r['forCorp']) ? ($namen[$r['issuerCorpId']] ?? '') : '';
    }
    unset($r);

    return $rijen;
}

// ---------------------------------------------------------------- mineralen thuis

// Mineralen kopen in de eigen ruimte scheelt een sleep vanuit Jita. Daarom scannen
// we de thuisregio apart: ALLE item-exchange-contracten (geen prijsvloer — een
// stapel Tritanium kost maar een paar miljoen), en houden alleen contracten over
// waar mineralen in zitten. De waardering blijft tegen Jita, zodat je ziet of het
// goedkoper is dan zelf halen. Via de sov-kaart weet de frontend welke systemen
// van ons zijn; structure-namen lost die zelf op met het token van de gebruiker.
const CD_THUIS_REGIO     = 10000060;   // Delve
const CD_THUIS_ALLIANTIE = 99013537;   // Insidious. — "wij"
const CD_SOV_SECONDEN    = 21600;      // sov-kaart 6 uur vasthouden, verandert zelden
const CD_ERTS_SECONDEN   = 86400;      // ertslijst uit de SDE-bundels 1 dag vasthouden
const CD_CAT_ASTEROID    = 25;         // SDE-categorie van alle erts
// De acht mineralen (SDE-groep 18). Vast gegeven, dus geen SDE-lookup nodig.
const CD_MINERALEN = [34 => 'Tritanium', 35 => 'Pyerite', 36 => 'Mexallon', 37 => 'Isogen',
                      38 => 'Nocxium', 39 => 'Zydrine', 40 => 'Megacyte', 11399 => 'Morphite'];

/**
 * Gecomprimeerd erts dat je tot mineralen raffineert: {typeId: [naam, portie, inhoud]}.
 *
 * Compressed ore telt mee als mineralen-in-wording — een contract vol Compressed
 * Veldspar is net zo goed een mineralenkoop als een stapel Tritanium. Uit de
 * SDE-bundels: categorie Asteroid, naam "Compressed …" of "Batch Compressed …",
 * en de raffinage-uitkomst bestaat UITSLUITEND uit de acht mineralen. Dat sluit
 * ijs, maanerts en het gemengde X-Grade-erts (mineralen + maangoed) uit.
 * 'inhoud' is de raffinage-opbrengst per 'portie' stuks bij 100%.
 */
function cdErts(PDO $pdo): array {
    static $erts = null;
    if ($erts !== null) return $erts;
    $cache = cdCacheGet($pdo, 'cd_erts', CD_ERTS_SECONDEN);
    if ($cache) return $erts = $cache['data'];

    $lees = function (string $bestand): array {
        $ruw = @file_get_contents(__DIR__ . '/../' . $bestand);
        return $ruw === false ? [] : (json_decode($ruw, true) ?: []);
    };
    $namen = $lees('type-names.json');       // {typeId: naam}
    $info  = $lees('type-info.json');        // {typeId: [groepId, volume, portie]}
    $groepen = $lees('groups.json');         // {groepId: [naam, categorieId]}
    $rep   = $lees('reprocess.json');        // {typeId: [[materiaalId, aantal], …]}

    $erts = [];
    foreach ($namen as $tid => $naam) {
        if (!preg_match('/^(Batch )?Compressed /', $naam)) continue;
        $gid = (int)($info[$tid][0] ?? 0);
        if ((int)($groepen[$gid][1] ?? 0) !== CD_CAT_ASTEROID) continue;
        $inhoud = $rep[$tid] ?? [];
        if (!$inhoud) continue;
        foreach ($inhoud as $m) if (!isset(CD_MINERALEN[(int)$m[0]])) continue 2;
        $erts[(int)$tid] = ['naam' => $naam, 'portie' => max(1, (int)($info[$tid][2] ?? 1)), 'inhoud' => $inhoud];
    }
    if ($erts) cdCacheSet($pdo, 'cd_erts', $erts);
    return $erts;
}

/** Alle item-exchange-contracten in de thuisregio, nieuwste eerst (30 min cache). */
function cdThuisKandidaten(PDO $pdo, bool $force = false): array {
    $key = 'cd_lijst_thuis';
    $cache = $force ? null : cdCacheGet($pdo, $key, CD_LIJST_SECONDEN);
    if ($cache) return $cache['data'];

    $alles = cdRegioContracten(CD_THUIS_REGIO);
    if ($alles === null) {
        $oud = cdCacheGet($pdo, $key, 0);
        return $oud ? $oud['data'] : [];
    }

    $kandidaten = [];
    foreach ($alles as $c) {
        if (($c['type'] ?? '') !== 'item_exchange') continue;
        $kandidaten[] = [
            'id'         => (int)$c['contract_id'],
            'prijs'      => (float)($c['price'] ?? 0),
            'beloning'   => (float)($c['reward'] ?? 0),
            'volume'     => (float)($c['volume'] ?? 0),
            'titel'      => (string)($c['title'] ?? ''),
            'uitgegeven' => (string)($c['date_issued'] ?? ''),
            'verlooptOp' => (string)($c['date_expired'] ?? ''),
            'locatieId'  => (int)($c['start_location_id'] ?? 0),
            'issuerId'   => (int)($c['issuer_id'] ?? 0),
            'issuerCorpId' => (int)($c['issuer_corporation_id'] ?? 0),
            'forCorp'    => !empty($c['for_corporation']),
        ];
    }
    usort($kandidaten, fn($a, $b) => strcmp($b['uitgegeven'], $a['uitgegeven']));

    cdCacheSet($pdo, $key, $kandidaten);
    return $kandidaten;
}

/**
 * {systeemId: naam} van de systemen waar onze alliantie sov heeft.
 *
 * /sovereignty/map/ is openbaar maar groot (alle nullsec-systemen), dus die
 * houden we zes uur vast. De namen komen uit de gebundelde systems.json —
 * geen ESI-call per systeem.
 */
function cdEigenSystemen(PDO $pdo): array {
    $cache = cdCacheGet($pdo, 'cd_sov_thuis', CD_SOV_SECONDEN);
    if ($cache) return $cache['data'];

    [$ok, $kaart] = cdEsi('/sovereignty/map/');
    if (!$ok) {
        $oud = cdCacheGet($pdo, 'cd_sov_thuis', 0);
        return $oud ? $oud['data'] : [];
    }

    $systemen = [];
    $ruw = @file_get_contents(__DIR__ . '/../systems.json');
    if ($ruw !== false) $systemen = json_decode($ruw, true) ?: [];   // {id: [naam, sec, regio]}

    $uit = [];
    foreach ($kaart as $s) {
        if ((int)($s['alliance_id'] ?? 0) !== CD_THUIS_ALLIANTIE) continue;
        $sid = (int)($s['system_id'] ?? 0);
        $uit[(string)$sid] = $systemen[(string)$sid][0] ?? (string)$sid;
    }
    asort($uit);
    cdCacheSet($pdo, 'cd_sov_thuis', $uit);
    return $uit;
}

/**
 * Gescande contracten met mineralen of gecomprimeerd erts erin, gewaardeerd tegen Jita.
 *
 * 'korting' is hoeveel procent je onder de Jita-verkoopprijs betaalt (negatief
 * = duurder dan Jita, wat in nullsec nog steeds de moeite kan zijn). Bij een
 * contract met precies één soort mineraal of erts geven we ook de prijs per stuk.
 * Erts wordt tegen de Jita-prijs van het erts zelf gewaardeerd; wat het na
 * raffinage oplevert rekent de frontend uit (die kent het raffinagepercentage).
 */
function cdMineralen(PDO $pdo, array $kandidaten): array {
    $erts = cdErts($pdo);
    $ids = array_column($kandidaten, 'id');
    $inhoud = [];
    foreach (array_chunk($ids, 500) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        $st = $pdo->prepare("SELECT contract_id, items FROM cc_items WHERE contract_id IN ($in)");
        $st->execute($chunk);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $inhoud[(int)$r['contract_id']] = json_decode($r['items'], true) ?: [];
        }
    }

    // Eerst uitzeven op mineralen/erts, pas dan prijzen ophalen — anders waarderen
    // we honderden gefitte schepen voor niets.
    $met = [];
    $typeIds = [];
    foreach ($kandidaten as $k) {
        $items = $inhoud[$k['id']] ?? null;
        if (!$items) continue;
        $mineraal = false;
        foreach ($items as $i) {
            $tid = (int)($i['type_id'] ?? 0);
            if (!empty($i['is_included']) && (isset(CD_MINERALEN[$tid]) || isset($erts[$tid]))) { $mineraal = true; break; }
        }
        if (!$mineraal) continue;
        $met[] = $k;
        foreach ($items as $i) if (!empty($i['type_id'])) $typeIds[(int)$i['type_id']] = true;
    }
    if (!$met) return [];
    $typeIds = array_keys($typeIds);
    cdUpdatePrices($pdo, $typeIds);
    cdUpdateNames($pdo, $typeIds);

    $prijzen = [];
    foreach (array_chunk($typeIds, 500) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        $st = $pdo->prepare("SELECT * FROM cc_prices WHERE type_id IN ($in)");
        $st->execute($chunk);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $prijzen[(int)$r['type_id']] = $r;
    }

    $rijen = [];
    foreach ($met as $k) {
        $waardeJita = 0.0; $waardeMineralen = 0.0; $kostenGeef = 0.0;
        $stapels = ['mineralen' => [], 'erts' => []];
        $overig = []; $heeftInlever = false; $prijsOnbekend = false;

        foreach ($inhoud[$k['id']] as $i) {
            $tid    = (int)($i['type_id'] ?? 0);
            $aantal = (int)($i['quantity'] ?? 0);
            $p      = $prijzen[$tid] ?? null;
            $isBpc  = !empty($i['is_blueprint_copy']);
            $sell   = $isBpc ? 0.0 : (float)($p['sell_safe'] ?? 0);
            if (!$isBpc && !$sell) $prijsOnbekend = true;

            if (empty($i['is_included'])) {           // moet je zelf inleveren
                $kostenGeef += $sell * $aantal;
                $heeftInlever = true;
                continue;
            }
            $waardeJita += $sell * $aantal;
            if (isset(CD_MINERALEN[$tid]) || isset($erts[$tid])) {
                $waardeMineralen += $sell * $aantal;
                $soort = isset(CD_MINERALEN[$tid]) ? 'mineralen' : 'erts';
                $stapel = &$stapels[$soort];
                // Zelfde mineraal/erts kan in meerdere stapels zitten: samenvoegen.
                if (isset($stapel[$tid])) { $stapel[$tid]['aantal'] += $aantal; $stapel[$tid]['waarde'] += $sell * $aantal; }
                else {
                    $stapel[$tid] = ['typeId' => $tid, 'naam' => CD_MINERALEN[$tid] ?? $erts[$tid]['naam'], 'aantal' => $aantal,
                                     'jitaSell' => $sell, 'jitaBuy' => (float)($p['buy'] ?? 0), 'waarde' => $sell * $aantal];
                    // Bij erts ook wat het bij 100% raffinage oplevert (per portie).
                    if ($soort === 'erts') $stapel[$tid] += ['portie' => $erts[$tid]['portie'], 'inhoud' => $erts[$tid]['inhoud']];
                }
                unset($stapel);
            } else {
                $overig[] = ['typeId' => $tid, 'naam' => $p['name'] ?? ('#' . $tid), 'aantal' => $aantal,
                             'isBpc' => $isBpc, 'waarde' => $sell * $aantal];
            }
        }
        $mineralen = array_values($stapels['mineralen']);
        $ertsen    = array_values($stapels['erts']);
        usort($mineralen, fn($a, $b) => $b['waarde'] <=> $a['waarde']);
        usort($ertsen,    fn($a, $b) => $b['waarde'] <=> $a['waarde']);
        usort($overig,    fn($a, $b) => $b['waarde'] <=> $a['waarde']);

        $betaalt = $k['prijs'] + $kostenGeef - $k['beloning'];
        $puur    = !$overig;
        // Eén soort mineraal of erts en verder niets: dan is de prijs per stuk zinvol.
        $enkel   = (count($mineralen) + count($ertsen) === 1) ? ($mineralen[0] ?? $ertsen[0]) : null;
        $rijen[] = $k + [
            'betaalt'         => $betaalt,
            'waardeJita'      => $waardeJita,
            'waardeMineralen' => $waardeMineralen,
            'korting'         => $waardeJita > 0 ? (($waardeJita - $betaalt) / $waardeJita * 100) : null,
            'mineralen'       => $mineralen,
            'erts'            => $ertsen,
            'overig'          => array_slice($overig, 0, 6),
            'aantalOverig'    => count($overig),
            'puur'            => $puur,
            'perStuk'         => ($puur && $enkel && $enkel['aantal'] > 0) ? $betaalt / $enkel['aantal'] : null,
            'heeftInlever'    => $heeftInlever,
            'prijsOnbekend'   => $prijsOnbekend,
        ];
    }
    usort($rijen, fn($a, $b) => ($b['korting'] ?? -INF) <=> ($a['korting'] ?? -INF));

    // NPC-stations lost de server op (naam bevat het systeem); structures doet
    // de frontend met het token van de gebruiker.
    $locaties = cdLocaties($pdo, array_column($rijen, 'locatieId'));
    $naamIds = [];
    foreach ($rijen as $r) {
        if (!empty($r['issuerId']))     $naamIds[] = $r['issuerId'];
        if (!empty($r['forCorp']) && !empty($r['issuerCorpId'])) $naamIds[] = $r['issuerCorpId'];
    }
    $namen = cdNamen($pdo, $naamIds);
    foreach ($rijen as &$r) {
        $loc = $locaties[$r['locatieId']] ?? null;
        $r['locatie']    = $loc['naam'] ?? '';
        $r['systeem']    = $loc['systeem'] ?? '';
        $r['issuer']     = $namen[$r['issuerId']] ?? '';
        $r['issuerCorp'] = !empty($r['forCorp']) ? ($namen[$r['issuerCorpId']] ?? '') : '';
    }
    unset($r);
    return $rijen;
}

// ---------------------------------------------------------------- routes

$pdo = getDB();
cdSchema($pdo);
$action = $_GET['action'] ?? 'list';

// De thuisregio staat los van de hubs: eigen kandidatenlijst, zelfde scanner en
// inhoud-cache. Per verzoek weer hooguit CD_ITEMS_PER_CALL nieuwe contracten.
if ($action === 'mineralen') {
    $kandidaten = cdThuisKandidaten($pdo, !empty($_GET['refresh']));
    $scan  = cdScan($pdo, $kandidaten);
    $rijen = cdMineralen($pdo, $kandidaten);
    echo json_encode([
        'ok'            => true,
        'regio'         => 'Delve',
        'eigenSystemen' => cdEigenSystemen($pdo),
        'bijgewerkt'    => date('c'),
        'rows'          => $rijen,
        'totalen'       => [
            'kandidaten'  => count($kandidaten),
            'gescand'     => count($kandidaten) - $scan['nog_te_gaan'],
            'nog_te_gaan' => $scan['nog_te_gaan'],
            'mineraal'    => count($rijen),
        ],
    ]);
    exit;
}

$kandidaten = cdKandidaten($pdo, !empty($_GET['refresh']));
$scan = cdScan($pdo, $kandidaten);

if ($action === 'scan') {
    echo json_encode(['ok' => true] + $scan);
    exit;
}

$alle = cdWaardeer($pdo, $kandidaten);
$winst = array_values(array_filter($alle, fn($r) => $r['nettoSell'] > 0));

echo json_encode([
    'ok'         => true,
    'regios'     => array_map(fn($h) => $h[0], array_values(CD_HUBS)),
    'bijgewerkt' => date('c'),
    'rows'       => array_slice($winst, 0, CD_TOON),
    'totalen'    => [
        'kandidaten'  => count($kandidaten),
        'gewaardeerd' => count($alle),
        'nog_te_gaan' => $scan['nog_te_gaan'],
        'koopjes'     => count($winst),
        'beste'       => $winst ? $winst[0]['nettoSell'] : 0,
        'waarde'      => array_sum(array_column(array_slice($winst, 0, CD_TOON), 'waardeSell')),
        'vraagprijs'  => array_sum(array_column(array_slice($winst, 0, CD_TOON), 'betaalt')),
    ],
]);
