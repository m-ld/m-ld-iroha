import grpc from 'grpc';
import {
  CommandService_v1Client as CommandService, QueryService_v1Client as QueryService
} from 'iroha-helpers/lib/proto/endpoint_grpc_pb.js';
import { clone } from '@m-ld/m-ld';
import { MqttRemotes } from '@m-ld/m-ld/dist/mqtt';
import { MeldMemDown } from '@m-ld/m-ld/dist/memdown';

const [, , irohaAddress, bobPrivateKey] = process.argv;
const params = [irohaAddress, grpc.credentials.createInsecure()];
const commandService = new CommandService(...params);
const queryService = new QueryService(...params);
const genesis = await clone(new MeldMemDown, MqttRemotes, {
  '@id': 'BobClone',
  '@domain': 'test.m-ld.org',
  genesis: false,
  mqtt: { host: 'localhost', port: 1883 },
  logLevel: 'DEBUG'
}, /**@type MeldIrohaApp*/{
  // Bob is the non-genesis user
  principal: {
    '@id': 'https://bob.example/profile#me',
    ed25519PrivateKey: bobPrivateKey
  },
  iroha: { commandService, queryService }
});
// Tell the test to start sending test operations
process.send('ready');
// Send any update we receive back to the test
genesis.follow(update => {
  process.send(update);
});
// Close on request
process.on('message', async cmd => {
  if (cmd === 'close')
    await genesis.close();
});
