<?php
define('API_SECRET', '28bc7a30fb01e4279538efc58b339ccbbcba42dbf309095d');
$data_file = __DIR__ . '/len-ledger-data.json';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    header('Content-Type: application/json');
    $headers = getallheaders();
    $auth = $headers['X-Api-Key'] ?? $headers['x-api-key'] ?? '';
    if ($auth !== API_SECRET) { http_response_code(401); echo json_encode(['error'=>'unauthorized']); exit; }
    $body = file_get_contents('php://input');
    $data = json_decode($body, true);
    if (!$data || !isset($data['months']) || !isset($data['monthly_bill'])) { http_response_code(400); echo json_encode(['error'=>'invalid']); exit; }
    $data['last_updated'] = date('c');
    $tmp = $data_file . '.' . getmypid() . '.tmp';
    file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE));
    rename($tmp, $data_file); chmod($data_file, 0644);
    echo json_encode(['ok'=>true, 'updated_at'=>$data['last_updated']]);
    exit;
}

if (isset($_GET['json'])) {
    header('Content-Type: application/json'); header('Access-Control-Allow-Origin: *');
    if (file_exists($data_file)) { readfile($data_file); exit; }
    echo json_encode(['error'=>'no data','updated_at'=>null,'months'=>[],'monthly_bill'=>1697.43,'bill_items'=>[['name'=>'HOA','amount'=>248.63],['name'=>'Mortgage','amount'=>1343.80],['name'=>'DPA Loan','amount'=>105.00]],'current_month'=>null,'lifetime'=>['total_charged'=>0,'total_paid'=>0,'running_balance'=>0,'month_count'=>0]]);
    exit;
}

$ledger = null;
$embedded = ['updated_at'=>null,'monthly_bill'=>1697.43,'bill_items'=>[['name'=>'HOA','amount'=>248.63],['name'=>'Mortgage','amount'=>1343.80],['name'=>'DPA Loan','amount'=>105.00]],'payer_name'=>'Lynne Roeschlaub','months'=>[],'current_month'=>null,'lifetime'=>['total_charged'=>0,'total_paid'=>0,'running_balance'=>0,'month_count'=>0]];
if (file_exists($data_file)) { $ledger = json_decode(file_get_contents($data_file), true); if ($ledger) $embedded = $ledger; }
?>
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Lynne &amp; Aaron's Ledger</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Roboto,sans-serif;background:#0b0d14;color:#e0e2ec;padding:2rem 1rem;display:flex;justify-content:center}
  .container{max-width:960px;width:100%}
  .header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:2rem;flex-wrap:wrap;gap:.75rem}
  .header h1{font-size:1.5rem;font-weight:700;letter-spacing:-.01em}
  .header .sub{color:#6b7094;font-size:.8rem;margin-top:.15rem}
  .header .last-upd{color:#6b7094;font-size:.75rem}
  .summary{background:linear-gradient(135deg,#161b28,#1a1f2e);border:1px solid #262b3e;border-radius:12px;padding:1.25rem 1.5rem;margin-bottom:2rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1rem}
  .summary .stat .lbl{font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;color:#6b7094;margin-bottom:.2rem}
  .summary .stat .val{font-size:1.3rem;font-weight:700;font-variant-numeric:tabular-nums}
  .summary .stat .val.green{color:#22c55e}.summary .stat .val.red{color:#ef4444}
  .month-section{margin-bottom:1.5rem}
  .month-label{font-size:.8rem;font-weight:600;color:#6b7094;text-transform:uppercase;letter-spacing:.08em;margin-bottom:.5rem;padding-left:.25rem}
  .ledger-table{width:100%;border-collapse:collapse;font-size:.88rem;font-variant-numeric:tabular-nums}
  .ledger-table th{text-align:left;font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;color:#6b7094;font-weight:500;padding:.5rem .75rem;border-bottom:1px solid #1e2335}
  .ledger-table th.right{text-align:right}
  .ledger-table td{padding:.55rem .75rem;border-bottom:1px solid #181d2b;vertical-align:top}
  .ledger-table td.right{text-align:right}
  .ledger-table .date-col{white-space:nowrap;color:#6b7094;width:90px}
  .ledger-table .num-col{width:110px;min-width:100px}
  .ledger-table .charge{color:#ef4444}.ledger-table .payment{color:#22c55e}.ledger-table .balance-neg{color:#ef4444}.ledger-table .balance-pos{color:#22c55e}
  .ledger-table .row-bill td{font-weight:600}.ledger-table .row-bill .desc-col{color:#e0e2ec}
  .ledger-table .row-payment .desc-col{color:#b0b5ce}
  .ledger-table .row-total td{border-top:2px solid #262b3e;font-weight:700;padding-top:.65rem}
  .ledger-table .row-total .desc-col{color:#e0e2ec}
  .empty-state{text-align:center;padding:3rem 1rem;color:#6b7094}
  .empty-state .icon{font-size:2rem;margin-bottom:.75rem}
  .empty-state p{font-size:.9rem;line-height:1.4}
  @media(max-width:600px){body{padding:1rem .5rem}.ledger-table{font-size:.8rem}.ledger-table th,.ledger-table td{padding:.4rem}.ledger-table .num-col{width:auto;min-width:auto}}
</style></head><body>
<div class="container">
  <div class="header"><div><h1>Lynne &amp; Aaron's Ledger</h1><div class="sub">Monthly bill tracker</div></div><div class="last-upd" id="lastUpd">…</div></div>
  <div id="content"></div>
</div>
<script>
const DATA = <?php echo json_encode($embedded); ?>;
(function(){
  const $=id=>document.getElementById(id);
  const f=n=>(typeof n==='number'?n:0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const ft=iso=>iso?new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
  const nc=v=>v<0?'red':v>0?'green':'';
  function render(d){
    const el=$('content');
    const lt=d.lifetime;
    if(!d.months||!d.months.length){el.innerHTML='<div class="empty-state"><div class="icon">📒</div><p>No ledger data yet.</p></div>';return}
    let html='<div class="summary"><div class="stat"><div class="lbl">Running Balance</div><div class="val '+nc(lt.running_balance)+'">'+(lt.running_balance<0?'−':'')+'$'+f(Math.abs(lt.running_balance))+'</div></div><div class="stat"><div class="lbl">All-Time Paid</div><div class="val green">$'+f(lt.total_paid)+'</div></div><div class="stat"><div class="lbl">All-Time Billed</div><div class="val">$'+f(lt.total_charged)+'</div></div><div class="stat"><div class="lbl">Months</div><div class="val">'+lt.month_count+'</div></div></div>';
    for(const month of d.months){
      let lineBal=month.running_balance-month.month_balance;
      html+='<div class="month-section"><div class="month-label">'+month.label+'</div><table class="ledger-table"><thead><tr><th>Date</th><th>Description</th><th class="right num-col">Charges</th><th class="right num-col">Payments</th><th class="right num-col">Balance</th></tr></thead><tbody>';
      for(const e of month.entries){
        if(e.type==='bill'){lineBal+=e.charge;html+='<tr class="row-bill"><td class="date-col">'+e.date+'</td><td class="desc-col">'+e.description+'</td><td class="right num-col charge">$'+f(e.charge)+'</td><td class="right num-col"></td><td class="right num-col '+nc(lineBal)+'">'+(lineBal<0?'−':'')+'$'+f(Math.abs(lineBal))+'</td></tr>';}
        else{lineBal-=e.payment;const acct=e.mask?e.account+' (…'+e.mask+')':e.account;const desc=e.description+(acct?' · '+acct:'');html+='<tr class="row-payment"><td class="date-col">'+e.date+'</td><td class="desc-col">'+desc+'</td><td class="right num-col"></td><td class="right num-col payment">$'+f(e.payment)+'</td><td class="right num-col '+nc(lineBal)+'">'+(lineBal<0?'−':'')+'$'+f(Math.abs(lineBal))+'</td></tr>';}
      }
      html+='<tr class="row-total"><td></td><td class="desc-col">Month total</td><td class="right num-col charge">$'+f(month.total_charged)+'</td><td class="right num-col payment">$'+f(month.total_paid)+'</td><td class="right num-col '+nc(month.running_balance)+'">'+(month.running_balance<0?'−':'')+'$'+f(Math.abs(month.running_balance))+'</td></tr>';
      html+='</tbody></table></div>';
    }
    el.innerHTML=html;
    $('lastUpd').textContent=d.updated_at?'Updated '+ft(d.updated_at):'';
  }
  render(DATA);
  setInterval(async()=>{try{const r=await fetch(window.location.pathname+'?json&t='+Date.now());if(r.ok)render(await r.json())}catch{}},60_000);
})();
</script>
</body></html>