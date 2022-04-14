import grpc from 'grpc';
import {
  CommandService_v1Client as CommandService, QueryService_v1Client as QueryService
} from 'iroha-helpers/lib/proto/endpoint_grpc_pb.js';
import { cryptoHelper, queries } from 'iroha-helpers/lib/index.js';
import { describe, expect, test } from '@jest/globals';
import { TxBuilder } from 'iroha-helpers/lib/chain.js';
import { ConsensusCondition, initIrohaMeldDomain } from '..';
import { down, upAll } from 'docker-compose';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import aedes from 'aedes';
import { createServer } from 'net';
import { clone } from '@m-ld/m-ld';
import { MqttRemotes } from '@m-ld/m-ld/dist/mqtt';
import { MeldMemDown } from '@m-ld/m-ld/dist/memdown';
import { Statutory } from '@m-ld/m-ld/dist/constraints/Statutory';
import { PropertyShape } from '@m-ld/m-ld/dist/shacl';

const IROHA_ADDRESS = 'localhost:50051';
const adminPriv = /**@type string*/readFileSync(
  new URL('./data/admin@test.priv', import.meta.url), 'utf-8');
const txHashPattern = /^[\da-f]{32,}$/;

describe('Iroha consensus', () => {
  let commandService, queryService, aliceKeys, proofKey;

  beforeAll(async () => {
    // noinspection JSCheckFunctionSignatures use of URL instead of file
    await upAll({ cwd: new URL('.', import.meta.url), log: true });
    console.log('Waiting 10 seconds for Iroha to start');
    await new Promise(done => setTimeout(done, 10000));
    const params = [IROHA_ADDRESS, grpc.credentials.createInsecure()];
    commandService = new CommandService(...params);
    queryService = new QueryService(...params);
    aliceKeys = cryptoHelper.generateKeyPair();
    proofKey = randomBytes(8).toString('hex');
    console.log(aliceKeys); // For debugging
  }, 30000);

  afterAll(async () => {
    // noinspection JSCheckFunctionSignatures use of URL instead of file
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
  test('initialise blockchain with m-ld domain', async () => {
    const txRes = await initIrohaMeldDomain({
      '@id': randomBytes(8).toString('hex'),
      '@domain': 'test.m-ld.org',
      genesis: true
    }, {
      commandService,
      queryService,
      adminId: 'admin@test',
      defaultRole: 'user',
      adminEd25519PrivateKey: adminPriv,
      firstPrincipalEd25519PublicKey: aliceKeys.publicKey
    });
    expect(txRes.txHash).toEqual([
      expect.stringMatching(txHashPattern),
      expect.stringMatching(txHashPattern)
    ]);
  });

  describe('with m-ld clone', () => {
    let /**@type Server*/mqttBroker;
    let /**@type MeldClone*/genesis;
    let /**@type MeldMqttConfig*/config;
    let /**@type MeldIrohaApp*/app;

    beforeAll(done => {
      // Create MQTT broker for clone-clone communication
      const mqttHandler = new aedes();
      mqttBroker = createServer(mqttHandler.handle);
      mqttBroker.listen(1883, async () => {
        // Create genesis clone
        config = {
          '@id': randomBytes(8).toString('hex'),
          '@domain': 'test.m-ld.org',
          genesis: true,
          mqtt: { host: 'localhost', port: 1883 }
        };
        app = {
          // Alice is the genesis user
          principal: {
            '@id': 'https://alice.example/profile#me',
            ed25519PrivateKey: aliceKeys.privateKey
          },
          iroha: { commandService, queryService }
        };
        done();
      });
    });

    beforeEach(async () => {
      // Create a new genesis for every test
      genesis = await clone(new MeldMemDown, MqttRemotes, config, app);
    });

    afterEach(async () => {
      await genesis.close();
    });

    afterAll(done => {
      mqttBroker.close(done);
    });

    // This test creates an explicit consensus condition, instead of declaring
    // it in data, to directly test it. See 'with declared condition', below.
    test('consensus condition adds proof to blockchain', done => {
      genesis.follow(async (update, state) => {
        try { // noinspection JSCheckFunctionSignatures confused by extensions
          const cc = new ConsensusCondition({ env: { app, config } });
          const proofKey = await cc.prove(state, update, update['@principal']);
          expect(proofKey).toBeDefined();
          expect(await cc.getAccountDetail(proofKey).then(JSON.parse)).toEqual({
            pid: 'https://alice.example/profile#me',
            state: [{ '@id': 'fred', name: 'Fred' }]
          });
          done();
        } catch (e) {
          done(e);
        }
      });
      genesis.write({ '@id': 'fred', name: 'Fred' });
    });

    describe('with declared condition', () => {
      beforeEach(async () => {
        // Declare the statute and consensus condition
        await genesis.write({
          '@graph': [
            Statutory.declare(0),
            Statutory.declareStatute({
              statutoryShapes: [PropertyShape.declare('invoice-state')],
              sufficientConditions: ConsensusCondition.declare()
            })
          ]
        });
      });

      test('adds testable agreement proof', done => {
        genesis.follow(async update => {
          try {
            expect(update['@agree']).toMatch(/pk_[\da-f]{32}/);
            // A condition would not normally be tested in the originating clone
            // Using the condition here just to test the Iroha block exists
            const cc = new ConsensusCondition({ env: { app, config } });
            await expect(cc.getAccountDetail(update['@agree']).then(JSON.parse))
              .resolves.toEqual({
                pid: 'https://alice.example/profile#me',
                state: [{
                  // Note that an extension receives fully-expanded JSON-LD
                  '@id': 'http://test.m-ld.org/my-invoice',
                  'http://test.m-ld.org/#invoice-state': 'ALICE'
                }]
              });
            done();
          } catch (e) {
            done(e);
          }
        });
        genesis.write({ '@id': 'my-invoice', 'invoice-state': 'ALICE' });
      });
    });
  });

  // Pattern for proving agreement (creating proof to attach to agreement)
  test.skip('prove agreement', async () => {
    const txRes = await new TxBuilder()
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
      .send(commandService);
    expect(txRes.txHash).toEqual([
      expect.stringMatching(txHashPattern)
    ]);
  });

  // Pattern for testing agreement (verifying the proof)
  test.skip('test agreement proof', async () => {
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

