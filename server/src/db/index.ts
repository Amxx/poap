import { format } from 'date-fns';
import pgPromise from 'pg-promise';
import { PoapEvent, PoapSetting, Omit, Signer, Address, Transaction, TransactionStatus, ClaimQR } from '../types';
import { ContractTransaction } from 'ethers';

const db = pgPromise()({
  host: process.env.INSTANCE_CONNECTION_NAME ? `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}` : 'localhost',
  user: process.env.SQL_USER || 'poap',
  password: process.env.SQL_PASSWORD || 'poap',
  database: process.env.SQL_DATABASE || 'poap_dev',
});

function replaceDates(event: PoapEvent): PoapEvent {
  event.start_date = format(new Date(event.start_date), 'MM/DD/YYYY');
  event.end_date = format(new Date(event.end_date), 'MM/DD/YYYY');
  return event;
}

export async function getEvents(): Promise<PoapEvent[]> {
  const res = await db.manyOrNone<PoapEvent>('SELECT * FROM events ORDER BY start_date DESC');

  return res.map(replaceDates);
}

export async function getTransactions(limit: number, offset: number, statusList: string[]): Promise<Transaction[]> {
  let query = "SELECT * FROM server_transactions WHERE status IN (${statusList:csv}) ORDER BY created_date DESC" +
    " LIMIT ${limit} OFFSET ${offset}";
  const res = await db.result(query, {statusList, limit, offset});
  return res.rows
}

export async function getTotalTransactions(statusList: string[]): Promise<number> {
  let query = 'SELECT COUNT(*) FROM server_transactions WHERE status IN (${statusList:csv})'
  const res = await db.result(query, {statusList});
  return res.rows[0].count;
}

export async function getSigners(): Promise<Signer[]> {
  const res = await db.manyOrNone<Signer>('SELECT * FROM signers ORDER BY id ASC');
  return res;
}

export async function getPoapSettings(): Promise<PoapSetting[]> {
  const res = await db.manyOrNone<PoapSetting>('SELECT * FROM poap_settings ORDER BY id DESC');
  return res;
}

export async function getPoapSettingByName(name: string): Promise<null | PoapSetting> {
  const res = await db.oneOrNone<PoapSetting>('SELECT * FROM poap_settings WHERE name = $1', [name]);
  return res;
}

export async function updatePoapSettingByName(name:string, type:string, value:string): Promise<boolean> {
  let query = 'update poap_settings set type=${type}, value=${value} where name=${name}';
  let values = {type, value, name};
  const res = await db.result(query, values);
  return res.rowCount === 1;
}

export async function getSigner(address: string): Promise<null | Signer> {
  const res = await db.oneOrNone<Signer>('SELECT * FROM signers WHERE signer ILIKE $1', [address]);
  return res;
}

export async function getAvailableHelperSigners(): Promise<null | Signer[]> {
  const res = await db.manyOrNone  (`
    SELECT s.id, s.signer, SUM(case when st.status = 'pending' then 1 else 0 end) as pending_txs
    FROM signers s LEFT JOIN server_transactions st on s.signer = st.signer
    WHERE s.role != 'administrator'
    GROUP BY s.id, s.signer
    ORDER BY pending_txs, s.id ASC
  `);
  return res;
}

export async function getTransaction(tx_hash: string): Promise<null | Transaction> {
  const res = await db.oneOrNone<Transaction>('SELECT * FROM server_transactions WHERE tx_hash ILIKE $1', [tx_hash]);
  return res
}

export async function getPendingTxs(): Promise<Transaction[]> {
  const res = await db.manyOrNone<Transaction>("SELECT * FROM server_transactions WHERE status = 'pending' ORDER BY id ASC");
  return res;
}

export async function getPendingTxsAmount(signer: Signer): Promise<Signer> {
  const signer_address = signer.signer
  const status = TransactionStatus.pending;
  const res = await db.result('SELECT COUNT(*) FROM server_transactions WHERE status = ${status} AND signer = ${signer_address}', 
  {
    status,
    signer_address
  });
  signer.pending_tx = res.rows[0].count;
  return signer
}

export async function getEvent(id: number): Promise<null | PoapEvent> {
  const res = await db.oneOrNone<PoapEvent>('SELECT * FROM events WHERE id = $1', [id]);
  return res ? replaceDates(res) : res;
}

export async function getEventByFancyId(fancyid: string): Promise<null | PoapEvent> {
  const res = await db.oneOrNone<PoapEvent>('SELECT * FROM events WHERE fancy_id = $1', [fancyid]);
  return res ? replaceDates(res) : res;
}

export async function updateEvent(
  fancyId: string,
  changes: Pick<PoapEvent, 'signer' | 'signer_ip' | 'event_url' | 'image_url'>
): Promise<boolean> {
  const res = await db.result(
    'update events set signer=${signer}, signer_ip=${signer_ip}, event_url=${event_url}, image_url=${image_url} where fancy_id = ${fancy_id}',
    {
      fancy_id: fancyId,
      ...changes,
    }
  );
  return res.rowCount === 1;
}

export async function updateSignerGasPrice(
  Id: string,
  GasPrice: string
): Promise<boolean> {
  const res = await db.result(
    'update signers set gas_price=${gas_price} where id = ${id}',
    {
      gas_price: GasPrice,
      id: Id
    }
  );
  return res.rowCount === 1;
}

export async function createEvent(event: Omit<PoapEvent, 'id'>): Promise<PoapEvent> {
  const data = await db.one(
    'INSERT INTO events(${this:name}) VALUES(${this:csv}) RETURNING id',
    // 'INSERT INTO events (${this:names}) VALUES (${this:list}) RETURNING id',
    event
  );

  return {
    ...event,
    id: data.id as number,
  };
}

export async function saveTransaction(hash: string, nonce: number, operation: string, params: string, signer: Address, status: string, gas_price: string ): Promise<boolean>{
  let query = "INSERT INTO server_transactions(tx_hash, nonce, operation, arguments, signer, status, gas_price) VALUES (${hash}, ${nonce}, ${operation}, ${params}, ${signer}, ${status}, ${gas_price})";
  let values = {hash, nonce, operation, params: params.substr(0, 950), signer, status, gas_price};
  try{
    const res = await db.result(query, values);
    return res.rowCount === 1;
  } catch (e) {
    values.params = 'Error while saving transaction';
    const res = await db.result(query, values);
    return res.rowCount === 1;
  }
  return false;
}

export async function updateTransactionStatus(hash: string, status: TransactionStatus) {
  const res = await db.result(
    'update server_transactions set status=${status} where tx_hash = ${hash}',
    {
      status,
      hash,
    }
  );
  return res.rowCount === 1;
}

export async function getQrClaim(qr_hash: string): Promise<null | ClaimQR> {
  const res = await db.oneOrNone<ClaimQR>('SELECT * FROM qr_claims WHERE qr_hash=${qr_hash}', {qr_hash});
  return res;
}

export async function checkDualQrClaim(event_id: number, address: string): Promise<boolean> {
  const res = await db.oneOrNone<ClaimQR>('SELECT * FROM qr_claims WHERE event_id = ${event_id} AND beneficiary = ${address}', {
    event_id,
    address
  });
  return res === null;
}

export async function adQrClaim(qr_hash: string): Promise<null | ClaimQR> {
  const res = await db.oneOrNone<ClaimQR>('SELECT * FROM qr_claims WHERE qr_hash = $1', [qr_hash]);
  return res;
}

export async function claimQrClaim(qr_hash: string) {
  const res = await db.result('update qr_claims set claimed=true, claimed_date=current_timestamp where qr_hash = $1', [qr_hash]);
  return res.rowCount === 1;
}

export async function updateQrClaim(qr_hash: string, beneficiary:string, tx: ContractTransaction) {
  const tx_hash = tx.hash
  const signer = tx.from

  const res = await db.result('update qr_claims set tx_hash=${tx_hash}, beneficiary=${beneficiary}, signer=${signer} where qr_hash = ${qr_hash}',
  {
    tx_hash,
    beneficiary,
    signer,
    qr_hash
  });
  return res.rowCount === 1;
}
