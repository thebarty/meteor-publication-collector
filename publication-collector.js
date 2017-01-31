import { Mongo } from 'meteor/mongo';
import { MongoID } from 'meteor/mongo-id';
import { EventEmitter } from 'events';

const validMongoId = Match.OneOf(String, Mongo.ObjectID);

/*
  This class describes something like Subscription in
  meteor/meteor/packages/ddp/livedata_server.js, but instead of sending
  over a socket it just collects data.
*/
PublicationCollector = class PublicationCollector extends EventEmitter {

  constructor(context = {}) {
    super();
    check(context.userId, Match.Optional(String));

    // Object where the keys are collection names, and then the keys are _ids
    this._documents = {};
    this.unblock = () => {};
    this.userId = context.userId;
    this._idFilter = {
      idStringify: MongoID.idStringify,
      idParse: MongoID.idParse
    };
  }

  collect(name, ...args) {
    let callback;
    // extracts optional callback from latest argument
    if (_.isFunction(args[args.length - 1])) {
      callback = args.pop();
    }
    // adds a one time listener function for the "ready" event
    this.once('ready', (collections) => {
      if (_.isFunction(callback)) {
        callback(collections);
      }
      // immediately stop the subscription
      this.stop();
    });

    const handler = Meteor.server.publish_handlers[name];
    const result = handler.call(this, ...args);

    this._publishHandlerResult(result);
  }

  /**
   * Reproduces "_publishHandlerResult" processing
   * @see {@link https://github.com/meteor/meteor/blob/master/packages/ddp-server/livedata_server.js#L1045}
   */
  _publishHandlerResult(res) {
    const cursors = [];

    // publication handlers can return a collection cursor, an array of cursors or nothing.
    if (this._isCursor(res)) {
      cursors.push(res);
    } else if (Array.isArray(res)) {
      // check all the elements are cursors
      const areCursors = res.reduce((valid, cur) => valid && this._isCursor(cur), true);
      if (!areCursors) {
        this.error(new Error('Publish function returned an array of non-Cursors'));
        return;
      }
      // find duplicate collection names
      const collectionNames = {};
      for (let i = 0; i < res.length; ++i) {
        const collectionName = res[i]._getCollectionName();
        if ({}.hasOwnProperty.call(collectionNames, collectionName)) {
          this.error(new Error(
            `Publish function returned multiple cursors for collection ${collectionName}`
          ));
          return;
        }
        collectionNames[collectionName] = true;
        cursors.push(res[i]);
      }
    }

    if (cursors.length > 0) {
      try {
        // for each cursor we call _publishCursor method which starts observing the cursor and
        // publishes the results.
        cursors.forEach((cur) => {
          this._ensureCollectionInRes(cur._getCollectionName());
          cur._publishCursor(this);
        });
      } catch (e) {
        this.error(e);
        return;
      }
      // mark subscription as ready (_publishCursor does NOT call ready())
      this.ready();
    } else if (res) {
      // truthy values other than cursors or arrays are probably a
      // user mistake (possible returning a Mongo document via, say,
      // `coll.findOne()`).
      this.error(new Error('Publish function can only return a Cursor or an array of Cursors'));
    }
  }

  added(collection, id, fields) {
    check(collection, String);
    check(id, validMongoId);

    this._ensureCollectionInRes(collection);

    // Make sure to ignore the _id in fields
    const addedDocument = _.extend({_id: id}, _.omit(fields, '_id'));
    this._documents[collection][id] = addedDocument;
  }

  changed(collection, id, fields) {
    check(collection, String);
    check(id, validMongoId);

    this._ensureCollectionInRes(collection);

    const existingDocument = this._documents[collection][id];
    const fieldsNoId = _.omit(fields, '_id');

    if (existingDocument) {
      _.extend(existingDocument, fieldsNoId);

      // Delete all keys that were undefined in fields (except _id)
      _.forEach(fields, (value, key) => {
        if (value === undefined) {
          delete existingDocument[key];
        }
      });
    }
  }

  removed(collection, id) {
    check(collection, String);
    check(id, validMongoId);

    this._ensureCollectionInRes(collection);

    delete this._documents[collection][id];

    if (_.isEmpty(this._documents[collection])) {
      delete this._documents[collection];
    }
  }

  ready() {
    // Synchronously calls each of the listeners registered for the "ready" event
    this.emit('ready', this._generateResponse());
  }

  onStop(callback) {
    // Adds a one time listener function for the "stop" event
    this.once('stop', callback);
  }

  stop() {
    // Synchronously calls each of the listeners registered for the "stop" event
    this.emit('stop');
  }

  error(error) {
    throw error;
  }

  _isCursor(c) {
    return c && c._publishCursor;
  }

  _ensureCollectionInRes(collection) {
    this._documents[collection] = this._documents[collection] || {};
  }

  _generateResponse() {
    const output = {};

    _.forEach(this._documents, (documents, collectionName) => {
      output[collectionName] = _.values(documents);
    });

    return output;
  }
};
