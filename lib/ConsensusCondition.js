const { BatchBuilder, TxBuilder } = require('iroha-helpers/lib/chain');
const { queries } = require('iroha-helpers');
const { isPropertyObject, updateSubject, array, includesValue } = require('@m-ld/m-ld');
const crypto = require('crypto');

/**
 * Must conform to [A-Za-z0-9_]{1,64}
 * @type {string}
 * @see https://iroha.readthedocs.io/en/main/develop/api/commands.html#set-account-detail
 */
const PROOF_KEY_PREFIX = 'pk_';

/**
 * The expected configuration with which every clone is initialised, when using
 * an {@link ConsensusCondition}.
 *
 * @typedef {import('@m-ld/m-ld').MeldConfig} MeldIrohaConfig
 */

/**
 * @typedef {import('@m-ld/m-ld').AppPrincipal} IrohaPrincipal
 * @property {string} ed25519PrivateKey clone principal private key for signing
 * Iroha transactions
 * @see https://iroha.readthedocs.io/en/main/develop/keys.html
 */

/**
 * The expected app object with which every clone is initialised, when using a
 * {@link ConsensusCondition}.
 *
 * @typedef {import('@m-ld/m-ld').MeldApp} MeldIrohaApp
 * @property {object} [iroha.commandService] Iroha command service
 * @property {object} [iroha.queryService] Iroha query service
 * @property {IrohaPrincipal} principal clone app principal (override)
 * @see https://github.com/hyperledger/iroha-javascript#example
 */

/**
 * Utility class to initialise Iroha with a m-ld domain, and register users.
 * Requires an admin account.
 */
class IrohaMeldDomain {
  /**
   * @param {object} opts required parameters for initialisation
   * @param {string} opts.domainId m-ld domain name
   * @param {string} opts.adminId e.g. `'admin@test'`
   * @param {string} opts.adminEd25519PrivateKey
   * @param {object} opts.commandService Iroha command service
   */
  constructor({
    domainId,
    adminId,
    adminEd25519PrivateKey,
    commandService
  }) {
    this.domainId = domainId;
    this.adminId = adminId;
    this.adminEd25519PrivateKey = adminEd25519PrivateKey;
    this.commandService = commandService;
  }

  get accountId() {
    return `clone@${this.domainId}`;
  }

  /**
   * Initialises Iroha with a m-ld domain based on the given configuration.
   * Requires an 'admin' account with permission to create domains and accounts.
   *
   * Alternatively, the requisite domain and account could be created in the
   * genesis block.
   *
   * @param {object} iroha required parameters for initialisation
   * @param {string} iroha.defaultRole e.g. `'user'`
   * @param {string} iroha.firstPrincipalEd25519PublicKey first signatory user key
   */
  initialise({
    defaultRole,
    firstPrincipalEd25519PublicKey
  }) {
    return new BatchBuilder([
      new TxBuilder()
        .createDomain({
          domainId: this.domainId,
          defaultRole
        })
        .addMeta(this.adminId, 1)
        .tx,
      new TxBuilder()
        // Account should get default "user" role (see above)
        .createAccount({
          // One account for all clones
          accountName: 'clone',
          domainId: this.domainId,
          publicKey: firstPrincipalEd25519PublicKey
        })
        .addMeta(this.adminId, 1)
        .tx
    ]).setBatchMeta(0)
      .sign([this.adminEd25519PrivateKey], 0)
      .sign([this.adminEd25519PrivateKey], 1)
      .send(this.commandService);
  }

  /**
   * Registers a m-ld principal (user) to Iroha so they can add blocks.
   *
   * @param {string} newEd25519PublicKey the public key of the new signatory
   * @param {string} existingEd25519PrivateKey the private key of an existing signatory
   */
  registerPrincipal(newEd25519PublicKey, existingEd25519PrivateKey) {
    return new TxBuilder()
      .addSignatory({
        accountId: this.accountId,
        publicKey: newEd25519PublicKey
      })
      .addMeta(this.accountId, 1)
      .sign([existingEd25519PrivateKey])
      .send(this.commandService);
  }
}

/**
 * An agreement condition that proves agreement by adding a block to an Iroha
 * blockchain; and tests agreement by inspecting the blockchain for the
 * identified block.
 *
 * @implements {import('@m-ld/m-ld/dist/constraints/Statutory').ShapeAgreementCondition}
 */
class ConsensusCondition {
  /**
   * Creates the necessary metadata write to use a {@link ConsensusCondition}.
   *
   * @param {string} [id] the IRI identifier of the condition, for linking this
   * condition to a Statute
   * @param [requireOverride]
   * @returns {import('@m-ld/m-ld').Subject} to be written to the m-ld domain
   */
  static declare = (id, requireOverride) => ({
    '@id': id,
    '@type': 'http://js.m-ld.org/CommonJSModule',
    'http://js.m-ld.org/#require': requireOverride || '@m-ld/m-ld-iroha',
    'http://js.m-ld.org/#class': 'ConsensusCondition'
  });

  /**
   * @param {import('@m-ld/m-ld/dist/orm').ExtensionEnvironment} env
   */
  constructor({ env }) {
    const config = /**@type MeldIrohaConfig*/env.config;
    const app = /**@type MeldIrohaApp*/env.app;
    this.accountId = `clone@${config['@domain']}`;
    this.commandService = app.iroha.commandService;
    this.queryService = app.iroha.queryService;
    /**@type IrohaPrincipal*/this.appPrincipal = app.principal;
  }

  /**
   * The value entered into Iroha as proof of agreement
   * @typedef {object} ProofValue
   * @property {import('@m-ld/m-ld').GraphSubject[]} state Agreed final state of statutes
   * @property {string} pid Principal ID
   */

  /**
   * @param {import('@m-ld/m-ld').MeldReadState} state
   * @param {import('@m-ld/m-ld').GraphUpdate} affected
   * @param {import('@m-ld/m-ld').Reference} principalRef
   * @returns {Promise<any>}
   */
  async prove(
    state,
    affected,
    principalRef
  ) {
    if (principalRef == null)
      return false;
    const provedState = await new AffectedLoader(affected).load(state);
    const proofKey = PROOF_KEY_PREFIX + crypto.randomBytes(16).toString('hex');
    await this.setAccountDetail(proofKey, JSON.stringify(/**@type ProofValue*/{
      pid: principalRef['@id'],
      state: provedState
    }));
    return proofKey;
  }

  /**
   * @param {import('@m-ld/m-ld').MeldReadState} state
   * @param {import('@m-ld/m-ld').GraphUpdate} affected
   * @param {any} proof
   * @param {import('@m-ld/m-ld').Reference} [principalRef]
   * @returns {Promise<true | string>}
   */
  async test(
    state,
    affected,
    proof,
    principalRef
  ) {
    if (principalRef == null)
      return 'No principal in update';
    const proofKey = array(proof).find(v => typeof v == 'string' && v.startsWith(PROOF_KEY_PREFIX));
    if (proofKey == null)
      return 'No proof key in update';
    const proofValue = await this.getAccountDetail(proofKey);
    if (proofValue == null)
      return 'No proof in ledger';
    const proved = /**@type ProofValue*/JSON.parse(proofValue);
    if (proved.pid !== principalRef['@id'])
      return 'Proof principal does not match update principal';
    const actualState = await new AffectedLoader(affected).load(state);
    // TODO: O(provedState.length x actualState.length)
    for (let subject of actualState)
      for (let [property, value] of Object.entries(subject))
        if (isPropertyObject(property, value))
          if (proved.state.find(provedSubject =>
            provedSubject['@id'] === subject['@id'] &&
            includesValue(provedSubject, property, value)) == null)
            return 'Proof does not match update';
    return true;
  }

  setAccountDetail(key, value) {
    return new TxBuilder()
      .setAccountDetail({
        accountId: this.accountId,
        key,
        // Iroha does not properly escape the value
        value: JSON.stringify(value).slice(1, -1)
      })
      .addMeta(this.accountId, 1)
      .sign([this.appPrincipal.ed25519PrivateKey])
      .send(this.commandService);
  }

  async getAccountDetail(key) {
    return (await queries.getAccountDetail({
      privateKey: this.appPrincipal.ed25519PrivateKey,
      creatorAccountId: this.accountId,
      queryService: this.queryService,
      timeoutLimit: 5000
    }, {
      accountId: this.accountId,
      key,
      pageSize: 1,
      paginationKey: key,
      paginationWriter: this.accountId
    }))[this.accountId]?.[key];
  }
}

class AffectedLoader {
  /** @param {import('@m-ld/m-ld').GraphUpdate} affected */
  constructor(affected) {
    this.affected = affected;
    this.subjectPropertiesToLoad = /**@type {{ [key: string]: Set<string> }}*/{};
    this.addProperties(affected['@delete']);
    this.addProperties(affected['@insert']);
  }

  /**
   * @param {import('@m-ld/m-ld').MeldReadState} state
   * @returns {Promise<import('@m-ld/m-ld').GraphSubject[]>}
   */
  load(state) {
    return Promise.all(Object.entries(this.subjectPropertiesToLoad)
      .map(async ([id, props]) =>
        updateSubject(await state.get(id, ...props) ?? { '@id': id }, this.affected)));
  }

  /** @param {import('@m-ld/m-ld').GraphSubjects} subjects */
  addProperties(subjects) {
    for (let subject of subjects) {
      this.subjectPropertiesToLoad[subject['@id']] ??= new Set;
      Object.keys(subject).forEach(property => {
        if (isPropertyObject(property, subject[property]))
          this.subjectPropertiesToLoad[subject['@id']].add(property);
      });
    }
  }
}

module.exports = {
  IrohaMeldDomain,
  ConsensusCondition
};