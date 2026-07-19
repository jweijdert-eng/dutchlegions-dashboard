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
 *   GET ?action=list   → gewaardeerde contracten + voortgang
 *   GET ?action=scan   → alleen scannen (voor een periodieke warmer), geeft tellers
 */

require_once 'config.php';
cors();

// Regio's die gescand worden. Per regio een eigen kandidatenlijst-cache, zodat
// één verzoek nooit alle regio's tegelijk hoeft op te halen.
const CD_REGIOS = [
    10000002 => 'The Forge',   // Jita — veruit het grootste aanbod (~34 pagina's)
    10000055 => 'Branch',      // eigen space (1 pagina)
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
const CD_TOON            = 100;        // zoveel beste deals teruggeven
const CD_JITA_4_4        = 60003760;   // waarderen doen we altijd tegen Jita
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

/** Kandidaten van één regio ophalen (of uit de cache halen). */
function cdRegioKandidaten(PDO $pdo, int $regioId, string $regioNaam, bool $force = false): array {
    $key = 'cd_lijst_' . $regioId;
    $cache = $force ? null : cdCacheGet($pdo, $key, CD_LIJST_SECONDEN);
    if ($cache) return $cache['data'];

    [$ok, $eerste, $hdrs] = cdEsi("/contracts/public/{$regioId}/", ['page' => 1]);
    if (!$ok) {
        $oud = cdCacheGet($pdo, $key, 0);
        return $oud ? $oud['data'] : [];
    }
    $paginas = max(1, (int)($hdrs['x-pages'] ?? 1));
    $alles = $eerste;

    $start = time();
    for ($p = 2; $p <= $paginas; $p++) {
        if (time() - $start > CD_TIJD_BUDGET) break;   // rest volgt bij een volgende ronde
        [$ok2, $rows] = cdEsi("/contracts/public/{$regioId}/", ['page' => $p]);
        if (!$ok2 || !$rows) break;
        $alles = array_merge($alles, $rows);
    }

    $kandidaten = [];
    foreach ($alles as $c) {
        if (($c['type'] ?? '') !== 'item_exchange') continue;
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
            'regio'      => $regioNaam,
        ];
    }
    usort($kandidaten, fn($a, $b) => strcmp($b['uitgegeven'], $a['uitgegeven']));
    $kandidaten = array_slice($kandidaten, 0, CD_MAX_KANDIDATEN);

    cdCacheSet($pdo, $key, $kandidaten);
    return $kandidaten;
}

/**
 * Alle kandidaten uit alle regio's, nieuwste eerst.
 *
 * Elke regio heeft z'n eigen cache; per verzoek verversen we er hooguit één
 * (de oudste), zodat een verzoek nooit alle regio's tegelijk hoeft op te halen.
 */
function cdKandidaten(PDO $pdo, bool $force = false): array {
    $verversen = null;
    if (!$force) {
        $oudste = PHP_INT_MAX;
        foreach (CD_REGIOS as $rid => $rnaam) {
            $c = cdCacheGet($pdo, 'cd_lijst_' . $rid, 0);
            $ts = $c ? $c['ts'] : 0;                       // nooit opgehaald = hoogste prioriteit
            if (time() - $ts > CD_LIJST_SECONDEN && $ts < $oudste) { $oudste = $ts; $verversen = $rid; }
        }
    }

    $alles = [];
    foreach (CD_REGIOS as $rid => $rnaam) {
        $alles = array_merge($alles, cdRegioKandidaten($pdo, $rid, $rnaam, $force || $verversen === $rid));
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

/** Waardeer alles wat we in de cache hebben en geef de beste deals terug. */
function cdWaardeer(PDO $pdo, array $kandidaten): array {
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
        $regels = [];

        foreach ($items as $i) {
            $tid    = (int)($i['type_id'] ?? 0);
            $aantal = (int)($i['quantity'] ?? 0);
            $p      = $prijzen[$tid] ?? null;
            $isBpc  = !empty($i['is_blueprint_copy']);
            if ($isBpc) $bpc = true;
            if ($p && !empty($p['thin'])) $dun = true;

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
            'onbekend'   => false,
            'leeg'       => false,
        ];
    }

    usort($rijen, fn($a, $b) => $b['nettoSell'] <=> $a['nettoSell']);

    // Stationnamen + uitgevernamen erbij (alleen voor wat we tonen — scheelt lookups).
    $tonen = array_slice($rijen, 0, CD_TOON);
    $locaties = cdLocaties($pdo, array_column($tonen, 'locatieId'));
    // Zowel de speler als (bij corp-contracten) de corp opzoeken in één call.
    $naamIds = [];
    foreach ($tonen as $r) {
        if (!empty($r['issuerId']))     $naamIds[] = $r['issuerId'];
        if (!empty($r['forCorp']) && !empty($r['issuerCorpId'])) $naamIds[] = $r['issuerCorpId'];
    }
    $namen = cdNamen($pdo, $naamIds);
    foreach ($rijen as &$r) {
        $r['locatie'] = $locaties[$r['locatieId']]['naam'] ?? '';
        $r['systeem'] = $locaties[$r['locatieId']]['systeem'] ?? '';
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
    'regios'     => array_values(CD_REGIOS),
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
