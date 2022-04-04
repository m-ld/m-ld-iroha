import grpc from 'grpc';
import {
  CommandService_v1Client as CommandService, QueryService_v1Client as QueryService
} from 'iroha-helpers/lib/proto/endpoint_grpc_pb.js';
import { cryptoHelper, queries } from 'iroha-helpers/lib/index.js';
import { describe, expect, test } from '@jest/globals';
import { BatchBuilder, TxBuilder } from 'iroha-helpers/lib/chain.js';
import { down, upAll } from 'docker-compose';
import crypto from 'crypto';

const IROHA_ADDRESS = 'localhost:50051';
const adminPriv =
  'f101537e319568c765b2cc89698325604991dca57b9716b58016b253506cab70';
const txHashPattern = /^[0-9a-f]{32,}$/;

describe('Iroha API', () => {
  let commandService, queryService, aliceKeys, proofKey;

  beforeAll(async () => {
    await upAll({ cwd: new URL('.', import.meta.url), log: true });
    console.log('Waiting 10 seconds for Iroha to start');
    await new Promise(done => setTimeout(done, 10000));
    const params = [IROHA_ADDRESS, grpc.credentials.createInsecure()];
    commandService = new CommandService(...params);
    queryService = new QueryService(...params);
    aliceKeys = cryptoHelper.generateKeyPair();
    proofKey = crypto.randomBytes(8).toString('hex');
    console.log(aliceKeys); // For debugging
  }, 30000);

  afterAll(async () => {
    await down({ cwd: new URL('.', import.meta.url) });
  });

  // Checking that Iroha has initialised and has a genesis block
  test('get genesis block', async () => {
    const block = await queries.getBlock({
      privateKey: adminPriv,
      creatorAccountId: 'admin@test',
      queryService,
      timeoutLimit: 5000
    }, {
      height: 1
    });
    expect(block.payload.txNumber).toBe(1);
  });

  // Initialisation with domain, account and first signatory
  test('initialise with m-ld domain', async () => {
    const txRes = await new BatchBuilder([
      new TxBuilder()
        .createDomain({
          domainId: 'test.m-ld.org',
          defaultRole: 'user'
        })
        .addMeta('admin@test', 1)
        .tx,
      new TxBuilder()
        // Account should get default "user" role (see above)
        .createAccount({
          // One account for all clones
          accountName: 'clone',
          domainId: 'test.m-ld.org',
          // Alice is the first signatory on this account
          publicKey: aliceKeys.publicKey
        })
        .addMeta('admin@test', 1)
        .tx
    ]).setBatchMeta(0)
      .sign([adminPriv], 0)
      .sign([adminPriv], 1)
      .send(commandService);
    expect(txRes.txHash).toEqual([
      expect.stringMatching(txHashPattern),
      expect.stringMatching(txHashPattern)
    ]);
  });

  // Pattern for proving agreement (creating proof to attach to agreement)
  test('prove agreement', async () => {
    const txRes = (await new TxBuilder()
      .setAccountDetail({
        accountId: 'clone@test.m-ld.org',
        key: proofKey,
        // Iroha does not properly escape JSON!
        value: JSON.stringify(JSON.stringify({
          // Principal ID
          pid: 'alice',
          // Agreed final state of statutes
          state: {
            '@id': 'my-invoice',
            'invoice-state': 'ordered'
          }
        })).slice(1, -1)
      })
      .addMeta('clone@test.m-ld.org', 1)
      .sign([aliceKeys.privateKey])
      .send(commandService));
    expect(txRes.txHash).toEqual([
      expect.stringMatching(txHashPattern)
    ]);
  });

  // Pattern for testing agreement (verifying the proof)
  test('test agreement proof', async () => {
    const res = await queries.getAccountDetail({
      privateKey: aliceKeys.privateKey,
      creatorAccountId: 'clone@test.m-ld.org',
      queryService,
      timeoutLimit: 5000
    }, {
      accountId: 'clone@test.m-ld.org',
      key: proofKey,
      pageSize: 1,
      paginationKey: proofKey,
      paginationWriter: 'clone@test.m-ld.org'
    });
    expect(JSON.parse(res['clone@test.m-ld.org'][proofKey])).toEqual({
      // See previous test
      pid: 'alice', state: { '@id': 'my-invoice', 'invoice-state': 'ordered' }
    });
  });
});

