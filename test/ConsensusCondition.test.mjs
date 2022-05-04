import grpc from 'grpc';
import {
  CommandService_v1Client as CommandService, QueryService_v1Client as QueryService
} from 'iroha-helpers/lib/proto/endpoint_grpc_pb.js';
import { cryptoHelper, queries } from 'iroha-helpers/lib/index.js';
import { describe, expect, test } from '@jest/globals';
import { ConsensusCondition, IrohaMeldDomain } from '..';
import { down, upAll } from 'docker-compose';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import aedes from 'aedes';
import { createServer } from 'net';
import { clone } from '@m-ld/m-ld';
import { MqttRemotes } from '@m-ld/m-ld/ext/mqtt';
import { MeldMemDown } from '@m-ld/m-ld/ext/memdown';
import { Statutory } from '@m-ld/m-ld/ext/constraints/Statutory';
import { PropertyShape } from '@m-ld/m-ld/ext/shacl';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const IROHA_ADDRESS = 'localhost:50051';
const adminPriv = /**@type string*/readFileSync(
  new URL('./data/admin@test.priv', import.meta.url), 'utf-8');
const txHashPattern = /^[\da-f]{32,}$/;

describe('Iroha consensus', () => {
  let commandService, queryService, aliceKeys, proofKey, irohaDomain;

  beforeAll(async () => {
    // noinspection JSCheckFunctionSignatures use of URL instead of file
    await upAll({ cwd: new URL('.', import.meta.url), log: true });
    console.log('Waiting 10 seconds for Iroha to start');
    await new Promise(done => setTimeout(done, 10000));
    const params = [IROHA_ADDRESS, grpc.credentials.createInsecure()];
    commandService = new CommandService(...params);
    queryService = new QueryService(...params);
    irohaDomain = new IrohaMeldDomain({
      domainId: 'test.m-ld.org',
      adminId: 'admin@test',
      adminEd25519PrivateKey: adminPriv,
      commandService
    });
    aliceKeys = cryptoHelper.generateKeyPair();
    proofKey = randomBytes(8).toString('hex');
  }, 30000);

  afterAll(async () => {
    // noinspection JSCheckFunctionSignatures use of URL instead of file
    await down({ cwd: new URL('.', import.meta.url) });
  }, 30000);

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
  // NOTE this test is necessary setup for the following suite
  test('initialise blockchain with m-ld domain', async () => {
    const txRes = await irohaDomain.initialise({
      defaultRole: 'user',
      firstPrincipalEd25519PublicKey: aliceKeys.publicKey
    });
    expect(txRes.txHash).toEqual([
      expect.stringMatching(txHashPattern),
      expect.stringMatching(txHashPattern)
    ]);
  });

  describe('with m-ld clone', () => {
    let /**@type import('net').Server*/mqttBroker;
    let /**@type import('aedes').Aedes}*/mqttHandler;
    let /**@type import('@m-ld/m-ld').MeldClone*/genesis;
    let /**@type import('@m-ld/m-ld/ext/mqtt').MeldMqttConfig*/config;
    let /**@type MeldIrohaApp*/app;

    beforeAll(done => {
      // Create MQTT broker for clone-clone communication
      mqttHandler = new aedes();
      mqttBroker = createServer(mqttHandler.handle);
      mqttBroker.listen(1883, async () => {
        // Create genesis clone
        config = {
          '@id': 'AliceClone',
          '@domain': 'test.m-ld.org',
          genesis: true,
          mqtt: { host: 'localhost', port: 1883 },
          logLevel: 'DEBUG'
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
      mqttHandler.close(() => mqttBroker.close(done));
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
              sufficientConditions: ConsensusCondition.declare('iroha-condition', process.cwd())
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

      test('proves at remote clone', async () => {
        const bobKeys = cryptoHelper.generateKeyPair();
        await irohaDomain.registerPrincipal(bobKeys.publicKey, aliceKeys.privateKey);
        const bobProcess = fork(
          fileURLToPath(new URL('./bobClone.mjs', import.meta.url)),
          [IROHA_ADDRESS, bobKeys.privateKey], { timeout: 10000 });
        return new Promise((resolve, reject) => {
          const updatesSeen = [];
          bobProcess.on('message', async msg => {
            if (msg === 'ready') {
              try {
                await genesis.write({ '@id': 'fred', name: 'Fred' });
                await genesis.write({ '@id': 'my-invoice', 'invoice-state': 'ALICE' });
              } catch (e) {
                reject(e);
              }
            } else if (typeof msg == 'object' && '@insert' in msg) {
              const i = updatesSeen.push(msg);
              if (i === 1) {
                expect(msg).toMatchObject({
                  '@insert': [{ '@id': 'fred', name: 'Fred' }],
                  '@principal': { '@id': 'https://alice.example/profile#me' }
                });
              } else if (i === 2) {
                expect(msg).toMatchObject({
                  '@insert': [{ '@id': 'my-invoice', 'invoice-state': 'ALICE' }],
                  '@principal': { '@id': 'https://alice.example/profile#me' },
                  '@agree': expect.stringMatching(/pk_[\da-f]{32}/)
                });
                bobProcess.send('close');
                resolve();
              }
            }
          });
        });
      }, 20000);
    });
  });
});

