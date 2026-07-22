<?php
/**
 * Hub-to-hub arbitrage: koop een item in de goedkoopste handelshub, versleep het
 * en verkoop het in de duurste. We vergelijken de LAAGSTE verkooporder-prijs
 * (sell.min) per item in de vijf grote hubs.
 *
 * Prijzen komen van Fuzzwork's aggregates-API (net als de koopjesjacht), per
 * station, en worden 1 uur gecached in `ha_prices`. De frontend stuurt een lijst
 * type-ids (uit een gekozen categorie) mee; wij zorgen dat die vers zijn en geven
 * de kansen terug. Duurt het ophalen te lang, dan geven we alvast terug wat we
 * hebben plus een `pending`-teller — de frontend belt dan gewoon nog een keer.
 *
 *   POST { "types": [34, 35, ...] }
 *   → { ok, hubs:[...namen], pending:int, rows:[ {t,bh,bp,sh,sp,ss}, ... ] }
 *     t=type-id, bh=koop-hub, bp=koopprijs, sh=verkoop-hub, sp=verkoopprijs,
 *     ss=verkoop-voorraad (aanbod-volume in de verkoop-hub, ruwe concurrentie-maat)
 */

require_once 'config.php';
cors();

// hub-naam => station-id (de vijf grote handelshubs)
const HA_HUBS = [
    'Jita'    => 60003760,
    'Amarr'   => 60008494,
    'Dodixie' => 60011866,
    'Rens'    => 60004588,
    'Hek'     => 60005686,
];
const HA_TTL          = 3600;   // prijzen 1 uur vasthouden
const HA_MAX_TYPES    = 6000;   // max type-ids per verzoek (tegen misbruik)
const HA_CHUNK        = 100;    // type-ids per Fuzzwork-call
const HA_TIJD_BUDGET  = 15;     // niet langer dan dit prijzen ophalen (PHP-limiet)
const HA_MAX_ROWS     = 500;    // zoveel beste kansen teruggeven

function haSchema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS ha_prices (
        station INT NOT NULL,
        type_id INT NOT NULL,
        sell DOUBLE NOT NULL DEFAULT 0,
        sell_vol DOUBLE NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (station, type_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
}

/** Simpele GET met hergebruikte curl-handle. Geeft de response-body (of ''). */
function haHttp(string $url): string {
    static $ch = null;
    if ($ch === null) $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_HTTPGET        => true,
        CURLOPT_HTTPHEADER     => ['User-Agent: dutchlegions-dashboard (hub-arbitrage)'],
    ]);
    $body = curl_exec($ch);
    return ($body === false) ? '' : $body;
}

// ---------------------------------------------------------------- input

$body  = json_decode(file_get_contents('php://input'), true) ?: [];
$types = array_values(array_unique(array_filter(array_map('intval', $body['types'] ?? []))));
$types = array_slice($types, 0, HA_MAX_TYPES);

$pdo = getDB();
haSchema($pdo);

if (!$types) {
    echo json_encode(['ok' => true, 'hubs' => array_keys(HA_HUBS), 'pending' => 0, 'rows' => []]);
    exit;
}

$naamVanStation = array_flip(HA_HUBS);   // station-id => hub-naam

// ---------------------------------------------------------------- prijzen verversen

// Per hub: welke gevraagde types zijn nog niet vers? Die halen we op bij Fuzzwork,
// tot het tijdsbudget op is. De rest telt als 'pending' (volgende verzoek pakt 'm).
$start   = time();
$pending = 0;

foreach (HA_HUBS as $hubNaam => $station) {
    $vers = [];
    foreach (array_chunk($types, 1000) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        $st = $pdo->prepare("SELECT type_id FROM ha_prices WHERE station = ? AND type_id IN ($in)
                             AND updated_at > DATE_SUB(NOW(), INTERVAL " . HA_TTL . " SECOND)");
        $st->execute(array_merge([$station], $chunk));
        foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $t) $vers[(int)$t] = true;
    }
    $todo = array_values(array_filter($types, fn($t) => !isset($vers[$t])));
    if (!$todo) continue;

    $ins = $pdo->prepare('INSERT INTO ha_prices (station, type_id, sell, sell_vol, updated_at)
                          VALUES (?, ?, ?, ?, NOW())
                          ON DUPLICATE KEY UPDATE sell = VALUES(sell), sell_vol = VALUES(sell_vol),
                              updated_at = NOW()');

    foreach (array_chunk($todo, HA_CHUNK) as $chunk) {
        if (time() - $start > HA_TIJD_BUDGET) { $pending += count($chunk); continue; }
        $data = json_decode(haHttp('https://market.fuzzwork.co.uk/aggregates/?station=' . $station
                                   . '&types=' . implode(',', $chunk)), true);
        // Elk gevraagd type een rij geven (ook 0 als er geen orders zijn), zodat we
        // het niet elk uur opnieuw proberen op te halen.
        foreach ($chunk as $t) {
            $row  = is_array($data) ? ($data[$t] ?? $data[(string)$t] ?? null) : null;
            $sell = $row ? (float)($row['sell']['min'] ?? 0) : 0;
            $vol  = $row ? (float)($row['sell']['volume'] ?? 0) : 0;
            $ins->execute([$station, $t, $sell, $vol]);
        }
    }
}

// ---------------------------------------------------------------- kansen bepalen

// Alle (verse of oude) prijzen voor de gevraagde types ophalen en per type de
// goedkoopste en duurste hub zoeken.
$sellPerType  = [];   // type_id => [hub => sell]
$stockPerType = [];   // type_id => [hub => sell_vol]
foreach (array_chunk($types, 1000) as $chunk) {
    $in = implode(',', array_fill(0, count($chunk), '?'));
    $st = $pdo->prepare("SELECT station, type_id, sell, sell_vol FROM ha_prices WHERE type_id IN ($in)");
    $st->execute($chunk);
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $hub  = $naamVanStation[(int)$r['station']] ?? null;
        $sell = (float)$r['sell'];
        if (!$hub || $sell <= 0) continue;                 // geen aanbod in die hub
        $sellPerType[(int)$r['type_id']][$hub]  = $sell;
        $stockPerType[(int)$r['type_id']][$hub] = (float)$r['sell_vol'];
    }
}

$rows = [];
foreach ($sellPerType as $t => $perHub) {
    if (count($perHub) < 2) continue;                      // in minstens 2 hubs verkrijgbaar
    $koopHub  = array_keys($perHub, min($perHub))[0];      // goedkoopste (hier kopen)
    $verkHub  = array_keys($perHub, max($perHub))[0];      // duurste (hier verkopen)
    $bp = $perHub[$koopHub];
    $sp = $perHub[$verkHub];
    if ($sp <= $bp) continue;
    $rows[] = [
        't'  => (int)$t,
        'bh' => $koopHub, 'bp' => round($bp, 2),
        'sh' => $verkHub, 'sp' => round($sp, 2),
        'ss' => $stockPerType[$t][$verkHub] ?? 0,
    ];
}

// Grootste bruto-marge eerst; de frontend doet de fijne filtering (fees, m³, ...).
usort($rows, fn($a, $b) => ($b['sp'] - $b['bp']) <=> ($a['sp'] - $a['bp']));
$rows = array_slice($rows, 0, HA_MAX_ROWS);

echo json_encode(['ok' => true, 'hubs' => array_keys(HA_HUBS), 'pending' => $pending, 'rows' => $rows]);
