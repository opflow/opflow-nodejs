'use strict';

var Promise = require('bluebird');
var lodash = require('lodash');
var assert = require('chai').assert;
var expect = require('chai').expect;
var miss = require('mississippi');
var streamBuffers = require('stream-buffers');
var debugx = require('debug')('bdd:opflow:engine');
var OpflowEngine = require('../../lib/engine');
var OpflowExecutor = require('../../lib/executor');
var LogTracer = require('../../lib/log_tracer');
var misc = require('../../lib/util');
var appCfg = require('../lab/app-configuration');
var bogen = require('../lab/big-object-generator');
var Loadsync = require('loadsync');

describe('opflow-engine:', function() {
	this.timeout(1000 * 60 * 60);

	var logCounter = {};
	before(function() {
		LogTracer.clearStringifyInterceptors();
		LogTracer.addStringifyInterceptor(function(logobj) {
			appCfg.updateCounter(logCounter, [{
				message: 'getConnection() - connection is created',
				fieldName: 'connectionCreated'
			}, {
				message: 'closeConnection() - connection is closed',
				fieldName: 'connectionDestroyed'
			}, {
				message: 'getChannel() - make a new channel',
				fieldName: 'channelCreated'
			}, {
				message: 'closeChannel() - channel is closed',
				fieldName: 'channelDestroyed'
			}, {
				message: 'getChannel() - createConfirmChannel',
				fieldName: 'confirmChannel'
			}, {
				message: 'getProducerSandbox() - create producer sandbox',
				fieldName: 'producerSandbox'
			}, {
				message: 'lockProducer() - obtain mutex',
				fieldName: 'producerLocked'
			}, {
				message: 'lockProducer() - release mutex',
				fieldName: 'producerUnlocked'
			}, {
				message: 'lockProducer() - obtain semaphore',
				fieldName: 'producerLocked'
			}, {
				message: 'unlockProducer() - release semaphore',
				fieldName: 'producerUnlocked'
			}, {
				message: 'getConsumerSandbox() - create consumer sandbox',
				fieldName: 'consumerSandbox'
			}, {
				message: 'lockConsumer() - obtain mutex',
				fieldName: 'consumerLocked'
			}, {
				message: 'unlockConsumer() - release mutex',
				fieldName: 'consumerUnlocked'
			}, {
				message: 'produce() add new object to confirmation list',
				fieldName: 'produceInvoked'
			}, {
				message: 'produce() channel is writable, msg has been sent',
				fieldName: 'produceSent'
			}, {
				message: 'produce() channel is overflowed, waiting',
				fieldName: 'produceOverflowed'
			}, {
				message: 'produce() channel is drained, flushed',
				fieldName: 'produceDrained'
			}, {
				message: 'produce() confirmation has failed',
				fieldName: 'confirmationFailed'
			}, {
				message: 'produce() confirmation has completed',
				fieldName: 'confirmationCompleted'
			}, {
				message: 'payloadWriter is interrupted',
				fieldName: 'payloadWriterClosed'
			}], logobj);
		});
	});

	after(function() {
		LogTracer.clearStringifyInterceptors();
	})

	describe('consume() method:', function() {
		var handler;
		var executor;
		var queue = {
			queueName: 'tdd-opflow-queue',
			durable: true,
			noAck: true,
			binding: true
		};

		before(function(done) {
			handler = new OpflowEngine(appCfg.extend());
			executor = new OpflowExecutor({ engine: handler });
			executor.purgeQueue(queue).then(lodash.ary(done, 0));
		});

		beforeEach(function(done) {
			appCfg.checkSkip.call(this);
			logCounter = {};
			handler.ready().then(function() {
				return executor.purgeQueue(queue);
			}).then(lodash.ary(done, 0));
		});

		afterEach(function(done) {
			handler.close().then(function() {
				debugx.enabled && debugx('logCounter: ' + JSON.stringify(logCounter));
				if (LogTracer.isInterceptorEnabled) {
					assert.equal(logCounter.connectionCreated, logCounter.connectionDestroyed);
				}
				done();
			});
		});

		it('preserve the order of elements', function(done) {
			var total = 10;
			var index = 0;
			handler.consume(function(msg, info, finish) {
				var message_code = parseInt(msg.properties.correlationId);
				var message = JSON.parse(msg.content);
				assert(message.code === index++);
				assert.equal(msg.properties.appId, 'engine-operator-tdd');
				assert.equal(msg.properties.messageId, 'message#' + message_code);
				assert.deepInclude(msg.properties.headers, {
					key1: 'test ' + message_code,
					key2: 'test ' + (message_code + 1)
				});
				assert.isTrue(Object.keys(msg.properties.headers).length >= 2);
				finish();
				if (index >= total) {
					handler.cancelConsumer(info).then(lodash.ary(done, 0));
				}
			}, queue).then(function() {
				Promise.mapSeries(lodash.range(total), function(count) {
					return handler.produce({
						code: count, msg: 'Hello world'
					}, {
						appId: 'engine-operator-tdd',
						messageId: 'message#' + count,
						correlationId: JSON.stringify(count),
						headers: {
							key1: 'test ' + count,
							key2: 'test ' + (count + 1)
						}
					});
				});
			});
		});

		it('push elements to queue massively', function(done) {
			var max = 1000;
			var idx = lodash.range(max);
			var n0to9 = lodash.range(10);
			var count = 0;
			handler.consume(function(msg, info, finish) {
				var message = JSON.parse(msg.content.toString());
				var pos = idx.indexOf(message.code);
				if (pos >= 0) idx.splice(pos, 1);
				finish();
				count++;
				if (count >= max * 10) {
					debugx.enabled && debugx('All of messages have been processed');
					assert(idx.length === 0);
					handler.cancelConsumer(info).then(lodash.ary(done, 0));
				}
			}, queue).then(function() {
				Promise.reduce(lodash.range(max), function(state, n) {
					return Promise.each(n0to9, function(k) {
						handler.produce({ code: (10*n + k), msg: 'Hello world' });
					}).delay(1);
				}, {});
			});
		});

		it('push large elements to queue', function(done) {
			var total = 10;
			var index = 0;
			var bog = new bogen.BigObjectGenerator({numberOfFields: 1000, max: total});
			handler.consume(function(msg, info, finish) {
				var message = JSON.parse(msg.content);
				assert(message.code === index++);
				finish();
				if (index >= total) {
					handler.cancelConsumer(info).then(lodash.ary(done, 0));
				}
			}, queue).then(function() {
				Promise.mapSeries(lodash.range(total), function(count) {
					return bog.next().then(function(randobj) {
						return handler.produce(randobj);
					});
				});
			});
		});
	});

	describe('close() method:', function() {
		var handler;
		var executor;
		var queue = {
			queueName: 'tdd-opflow-queue',
			durable: true,
			noAck: true,
			binding: true,
			payloadEnabled: false
		};

		before(function(done) {
			handler = new OpflowEngine(appCfg.extend({
				confirmation: {}
			}));
			executor = new OpflowExecutor({ engine: handler });
			executor.purgeQueue(queue).then(lodash.ary(done, 0));
		});

		beforeEach(function(done) {
			appCfg.checkSkip.call(this);
			logCounter = {};
			handler.ready().then(function() {
				return executor.purgeQueue(queue);
			}).then(lodash.ary(done, 0));
		});

		afterEach(function(done) {
			debugx.enabled && debugx('logCounter: ' + JSON.stringify(logCounter));
			if (LogTracer.isInterceptorEnabled) {
				assert.equal(logCounter.connectionCreated, logCounter.connectionDestroyed);
				assert.equal(logCounter.channelCreated, logCounter.channelDestroyed);
				assert.equal(logCounter.confirmChannel, 1);
				assert.equal(logCounter.producerLocked, logCounter.producerUnlocked);
				assert.equal(logCounter.consumerLocked, logCounter.consumerUnlocked);
			}
			done();
		});

		it('close() doest not loose input data (small objects)', function(done) {
			var total = 1000;
			var idx = lodash.range(total);
			var bound = 100;
			var meter = { sent: 0, received: 0 };
			var loadsync = new Loadsync([{
				name: 'handler',
				cards: ['close', 'error']
			}]);
			loadsync.ready(function(info) {
				assert.isBelow(meter.sent, total);
				assert.isAtLeast(meter.sent, bound);
				assert.equal(meter.sent, meter.received);
				assert.equal(meter.received + idx.length, total);
				debugx.enabled && debugx('Meter: %s', JSON.stringify(meter));
				done();
			}, 'handler');
			handler.consume(function(msg, info, finish) {
				var message = JSON.parse(msg.content.toString());
				var pos = idx.indexOf(message.code);
				if (pos >= 0) idx.splice(pos, 1);
				finish();
				meter.received += 1;
				if (meter.received >= total) {
					debugx.enabled && debugx('All of messages have been processed');
					assert(idx.length === 0);
					handler.cancelConsumer(info).then(lodash.ary(done, 0));
				}
			}, queue).then(function() {
				return Promise.map(lodash.range(total), function(k) {
					if (k === bound) handler.close().finally(function() {
						loadsync.check('close', 'handler');
					});
					return handler.produce({ code: k, msg: 'Hello world' }).then(function(ok) {
						meter.sent += 1;
						return ok;
					});
				}, { concurrency: 10 });
			}).catch(function(err) {
				assert.equal(err.engineState, 'suspended');
				loadsync.check('error', 'handler');
			});
		});

		it('close() doest not loose input data (large objects)', function(done) {
			var total = 200;
			var index = 0;
			var bound = 70;
			var meter = { sent: 0, received: 0 };
			var loadsync = new Loadsync([{
				name: 'handler',
				cards: ['close', 'error']
			}]);
			loadsync.ready(function(info) {
				assert.isBelow(meter.sent, total);
				assert.equal(meter.sent, meter.received);
				if (LogTracer.isInterceptorEnabled) {
					logCounter.produceDrained = logCounter.produceDrained || 0;
					logCounter.produceOverflowed = logCounter.produceOverflowed || 0;
					assert.equal(logCounter.produceInvoked, meter.received);
					assert.equal(logCounter.produceInvoked, logCounter.confirmationCompleted);
					assert.equal(logCounter.produceInvoked, logCounter.produceSent + logCounter.produceOverflowed);
					assert.equal(logCounter.produceOverflowed, logCounter.produceDrained);
				}
				done();
			}, 'handler');
			var bog = new bogen.BigObjectGenerator({numberOfFields: 7000, max: total});
			handler.consume(function(msg, info, finish) {
				var message = JSON.parse(msg.content);
				assert(message.code === index++);
				finish();
				meter.received++;
				if (index >= total) {
					handler.cancelConsumer(info).then(lodash.ary(done, 0));
				}
			}, queue).then(function() {
				return Promise.map(lodash.range(total), function(count) {
					if (count === bound) handler.close().finally(function() {
						loadsync.check('close', 'handler');
					});
					return bog.next().then(function(randobj) {
						return handler.produce(randobj).then(function() {
							meter.sent++;
						});
					});
				}, { concurrency: 5 });
			}).catch(function(err) {
				assert.equal(err.engineState, 'suspended');
				loadsync.check('error', 'handler');
			});
		});

		it('close() doest not loose input data (streaming)', function(done) {
			var TIMEOUT = 100;
			var total = 50;
			var index = 0;
			var bound = 2;
			var meter = { sent: 0, received: 0 };
			var loadsync = new Loadsync([{
				name: 'handler',
				cards: ['close', 'error']
			}]);
			loadsync.ready(function(info) {
				debugx.enabled && debugx('Meter: %s', JSON.stringify(meter));
				if (LogTracer.isInterceptorEnabled) {
					logCounter.produceDrained = logCounter.produceDrained || 0;
					logCounter.produceOverflowed = logCounter.produceOverflowed || 0;
					assert.equal(logCounter.produceInvoked, meter.received);
					assert.equal(logCounter.produceInvoked, logCounter.confirmationCompleted);
				}
				done();
			}, 'handler');
			var bog = new bogen.BigObjectGenerator({numberOfFields: 7000, max: total, timeout: TIMEOUT});
			var bos = new bogen.BigObjectStreamify(bog, {objectMode: true});
			handler.consume(function(msg, info, finish) {
				var segmentIndex = misc.getHeaderField(msg.properties.headers, 'segmentIndex');
				if (segmentIndex !== undefined && segmentIndex >= 0) {
					var message = JSON.parse(msg.content);
					assert(message.code === index++);
				}
				meter.received++;
				finish();
				if (index >= total) {
					handler.cancelConsumer(info).then(lodash.ary(done, 0));
				}
			}, queue).then(function() {
				setTimeout(function() {
					handler.close().finally(function() {
						debugx.enabled && debugx('Engine has been closed');
						loadsync.check('close', 'handler');
					});
				}, 1000);
				return handler.produce(null, null, {payloadStream: bos});
			}).catch(function(err) {
				debugx.enabled && debugx('Error: %s', JSON.stringify(err));
				loadsync.check('error', 'handler');
			});
		});
	});

	describe('produce() customize routingKey', function() {
		var handler0;
		var handler1;
		var queue0 = {
			queueName: 'tdd-opflow-queue',
			durable: true,
			noAck: true,
			binding: true
		}
		var queue1 = {
			queueName: 'tdd-opflow-clone',
			durable: true,
			noAck: true,
			binding: true
		}
		var executor0;
		var executor1;

		before(function() {
			handler0 = new OpflowEngine(appCfg.extend());
			handler1 = new OpflowEngine(appCfg.extend({
				routingKey: 'tdd-opflow-backup',
				consumer: undefined,
				exchangeQuota: undefined
			}));
			executor0 = new OpflowExecutor({
				engine: handler0
			});
			executor1 = new OpflowExecutor({
				engine: handler1
			});
		});

		beforeEach(function(done) {
			appCfg.checkSkip.call(this);
			Promise.all([
				handler0.ready(), executor0.purgeQueue(queue0),
				handler1.ready(), executor1.purgeQueue(queue1)
			]).then(lodash.ary(done, 0));
		});

		afterEach(function(done) {
			Promise.all([
				handler0.close(),
				handler1.close()
			]).then(lodash.ary(done, 0));
		});

		it('copy message to another queue (CC)', function(done) {
			var total = 10;

			var loadsync = new Loadsync([{
				name: 'testsync',
				cards: ['handler0', 'handler1']
			}]);

			var index0 = 0;
			var ok0 = handler0.consume(function(msg, info, finish) {
				var message = JSON.parse(msg.content.toString());
				assert(message.code === index0++);
				finish();
				if (index0 >= total) {
					handler0.cancelConsumer(info).then(function() {
						loadsync.check('handler0', 'testsync');
					});
				}
			}, queue0);

			var index1 = 0;
			var ok1 = handler1.consume(function(msg, info, finish) {
				var message = JSON.parse(msg.content.toString());
				assert(message.code === index1++);
				finish();
				if (index1 >= total) {
					handler1.cancelConsumer(info).then(function() {
						loadsync.check('handler1', 'testsync');	
					});
				}
			}, queue1);

			loadsync.ready(function(info) {
				done();
			}, 'testsync');

			Promise.all([ok0, ok1]).then(function() {
				lodash.range(total).forEach(function(count) {
					handler0.produce({ code: count, msg: 'Hello world' }, {CC: 'tdd-opflow-backup'});
				});
			});
		});

		it('redirect to another queue by changing routingKey', function(done) {
			var total = 10;
			var index = 0;
			var ok1 = handler1.consume(function(msg, info, finish) {
				var message = JSON.parse(msg.content.toString());
				assert(message.code === index++);
				finish();
				if (index >= total) {
					handler1.cancelConsumer(info).then(lodash.ary(done, 0));
				}
			}, queue1);
			ok1.then(function() {
				lodash.range(total).forEach(function(count) {
					handler0.produce({ code: count, msg: 'Hello world' }, {}, {
						routingKey: 'tdd-opflow-backup'
					});
				});
			});
		});
	});

	describe('ConfirmChannel:', function() {
		var handler;
		var executor;
		var queue = {
			queueName: 'tdd-opflow-queue',
			durable: true,
			noAck: false,
			binding: true
		};

		before(function(done) {
			handler = new OpflowEngine(appCfg.extend({
				confirmation: {}
			}));
			executor = new OpflowExecutor({ engine: handler });
			executor.purgeQueue(queue).then(lodash.ary(done, 0));
		});

		beforeEach(function(done) {
			appCfg.checkSkip.call(this);
			logCounter = {};
			handler.ready().then(function() {
				return executor.purgeQueue(queue);
			}).then(lodash.ary(done, 0));
		});

		afterEach(function(done) {
			handler.close().then(function() {
				debugx.enabled && debugx('logCounter: ' + JSON.stringify(logCounter));
				if (LogTracer.isInterceptorEnabled) {
					assert.equal(logCounter.connectionCreated, logCounter.connectionDestroyed);
					assert.equal(logCounter.channelCreated, logCounter.channelDestroyed);
					assert.equal(logCounter.confirmChannel, 1);
					assert.equal(logCounter.producerLocked, logCounter.producerUnlocked);
				}
				done();
			});
		});

		it('Confirm that server has dispatched messages', function(done) {
			var total = 100;
			var index = 0;
			Promise.mapSeries(lodash.range(total), function(count) {
				return handler.produce({
					code: count, msg: 'Hello world'
				}, {
					appId: 'engine-operator-tdd',
					messageId: 'message#' + count,
					correlationId: JSON.stringify(count),
					headers: {
						key1: 'test ' + count,
						key2: 'test ' + (count + 1)
					}
				});
			}).then(lodash.ary(done, 0));
		});

		it('Resend messages that have not confirmed', function(done) {
			var total = 10;
			var index = 0;
			handler.consume(function(msg, info, finish) {
				var message_code = parseInt(msg.properties.correlationId);
				var message = JSON.parse(msg.content);
				assert(message.code === index++);
				assert.equal(msg.properties.appId, 'engine-operator-tdd');
				assert.equal(msg.properties.messageId, 'message#' + message_code);
				assert.deepInclude(msg.properties.headers, {
					key1: 'test ' + message_code,
					key2: 'test ' + (message_code + 1)
				});
				assert.isTrue(Object.keys(msg.properties.headers).length >= 2);
				finish();
				if (index >= total) {
					handler.cancelConsumer(info).then(lodash.ary(done, 0));
				}
			}, queue).then(function() {
				Promise.mapSeries(lodash.range(total), function(count) {
					return handler.produce({
						code: count, msg: 'Hello world'
					}, {
						appId: 'engine-operator-tdd',
						messageId: 'message#' + count,
						correlationId: JSON.stringify(count),
						headers: {
							key1: 'test ' + count,
							key2: 'test ' + (count + 1)
						}
					});
				});
			});
		});
	});

	describe('produce() streaming:', function() {
		var FIELDS = bogen.FIELDS || 10000;
		var TOTAL = bogen.TOTAL || 1000;
		var TIMEOUT = bogen.TIMEOUT || 0;
		var handler, executor;
		var queue = {
			queueName: 'tdd-opflow-queue',
			durable: true,
			noAck: false,
			binding: true,
			payloadEnabled: false
		};

		before(function(done) {
			handler = new OpflowEngine(appCfg.extend({
				confirmation: {}
			}));
			executor = new OpflowExecutor({ engine: handler });
			executor.purgeQueue(queue).then(lodash.ary(done, 0));
		});

		beforeEach(function(done) {
			appCfg.checkSkip.call(this);
			logCounter = {};
			handler.ready().then(function() {
				return executor.purgeQueue(queue);
			}).then(lodash.ary(done, 0));
		});

		afterEach(function(done) {
			handler.close().then(function() {
				debugx.enabled && debugx('logCounter: ' + JSON.stringify(logCounter));
				if (LogTracer.isInterceptorEnabled) {
					assert.equal(logCounter.connectionCreated, logCounter.connectionDestroyed);
					assert.equal(logCounter.channelCreated, logCounter.channelDestroyed);
					assert.equal(logCounter.confirmChannel, 1);
					assert.equal(logCounter.producerLocked, logCounter.producerUnlocked);
					assert.equal(logCounter.consumerLocked, logCounter.consumerUnlocked);
				}
				done();
			});
		});

		it('emit drain event if the produce() is overflowed', function(done) {
			var index = 0;
			var check = lodash.range(TOTAL);
			var bog = new bogen.BigObjectGenerator({numberOfFields: FIELDS, max: TOTAL, timeout: TIMEOUT});
			var segmentIdCount = 0;
			handler.consume(function(msg, info, finish) {
				var headers = msg.properties.headers;
				var segmentId = headers['segmentId'];
				var segmentIndex = headers['segmentIndex'];
				if (segmentIndex >= 0) {
					if (lodash.isString(segmentId) && segmentId.length > 0) {
						segmentIdCount++;
					}
					var message = JSON.parse(msg.content);
					check.splice(check.indexOf(message.code), 1);
				}
				finish();
				if (++index >= TOTAL + 2) {
					assert.equal(segmentIdCount, TOTAL);
					setTimeout(function() {
						if (LogTracer.isInterceptorEnabled) {
							assert.equal(logCounter.confirmationCompleted, TOTAL + 2);
						}
						handler.cancelConsumer(info).then(lodash.ary(done, 0));
					}, 500);
				}
			}, queue).then(function() {
				var bos = new bogen.BigObjectStreamify(bog, {objectMode: true});
				return handler.produce({}, null, { payloadStream: bos });
			}).then(function() {
				debugx.enabled && debugx('produce() - done');
			}).catch(function(err) {
				debugx.enabled && debugx('produce() - error');
				done(err);
			});
		});

		it('insert some messages to working stream', function(done) {
			var count = 0;
			var check = lodash.range(TOTAL);
			var bog = new bogen.BigObjectGenerator({numberOfFields: FIELDS, max: TOTAL-1, timeout: TIMEOUT});
			var bo9 = new bogen.BigObjectGenerator({numberOfFields: FIELDS, min: TOTAL-1, max: TOTAL, timeout: 0});
			var successive = true;
			var ok = handler.consume(function(msg, info, finish) {
				var segmentIndex = misc.getHeaderField(msg.properties.headers, 'segmentIndex');
				if (segmentIndex !== undefined && segmentIndex >= 0) {
					var message = JSON.parse(msg.content);
					if (message.code !== count) successive = false;
					check.splice(check.indexOf(message.code), 1);
				}
				finish();
				if (++count >= TOTAL + 2) {
					setTimeout(function() {
						if (LogTracer.isInterceptorEnabled) {
							assert.equal(logCounter.confirmationCompleted, TOTAL + 2);
						}
						handler.cancelConsumer(info).then(lodash.ary(done, 0));
					}, 500);
				}
			}, { payloadEnabled: false });
			ok.then(function() {
				var bos = new bogen.BigObjectStreamify(bog, {objectMode: true});
				setTimeout(function() {
					bo9.next().then(function(data) {
						debugx.enabled && debugx('produce() - inserting data');
						handler.produce(data).then(function() {
							debugx.enabled && debugx('produce() - data inserted');
						});
					});
				}, Math.round(100 + TIMEOUT * TOTAL / 2));
				debugx.enabled && debugx('produce() - start');
				return handler.produce({}, null, { payloadStream: bos });
			}).then(function() {
				debugx.enabled && debugx('produce() - done');
			}).catch(function(err) {
				debugx.enabled && debugx('produce() - error');
				done(err);
			});
		});

		it('produce/consume payload pipeline (using Readable.read())', function(done) {
			var FIELDS = 10;
			var TOTAL = 20;
			var TIMEOUT = 20;
			var count = 0;
			var check = lodash.range(TOTAL);
			var bog = new bogen.BigObjectGenerator({numberOfFields: FIELDS, max: TOTAL, timeout: TIMEOUT});
			var ok = handler.consume(function(msg, info, finish) {
				info.payloadStream.on('readable', function() {
					var chunk;
					while(null !== (chunk = info.payloadStream.read())) {
						debugx.enabled && debugx('Object: %s', chunk);
						var message = JSON.parse(chunk);
						check.splice(check.indexOf(message.code), 1);
					}
				}).on('end', function() {
					assert.equal(check.length, 0);
					finish();
					done();
				});
			}, { payloadEnabled: true });
			ok.then(function() {
				var bos = new bogen.BigObjectStreamify(bog, {objectMode: true});
				debugx.enabled && debugx('produce() - start');
				return handler.produce({}, null, {payloadStream: bos});
			}).then(function() {
				debugx.enabled && debugx('produce() - done');
			}).catch(function(err) {
				debugx.enabled && debugx('produce() - error');
				done(err);
			});
		});

		it('produce/consume payload pipeline (Using Readable.pipe())', function(done) {
			var TOTAL = 2;
			var LENGTH = 20;
			var TIMEOUT = 20;
			var count = 0;
			var check = lodash.range(TOTAL);
			var ok = handler.consume(function(msg, info, finish) {
				var writableStream = new streamBuffers.WritableStreamBuffer();
				info.payloadStream.on('end', finish)
				.pipe(writableStream)
				.on('finish', function () {
					var text = writableStream.getContentsAsString();
					assert.equal(text.length, TOTAL * LENGTH);
					for(var i=0; i<TOTAL; i++) {
						assert.equal(text.substr(i*LENGTH, LENGTH), lodash.repeat('' + i, LENGTH));
					}
					done();
				});
			}, { payloadEnabled: true });
			ok.then(function() {
				var payloadStream = new streamBuffers.ReadableStreamBuffer();
				for(var i=0; i<TOTAL; i++) {
					payloadStream.put(lodash.repeat('' + i, LENGTH));
				}
				debugx.enabled && debugx('produce() - start');
				var promise = handler.produce({}, null, {payloadStream: payloadStream});
				payloadStream.stop();
				return promise;
			}).then(function() {
				debugx.enabled && debugx('produce() - done');
			}).catch(function(err) {
				debugx.enabled && debugx('produce() - error');
				done(err);
			});
		});

		it('produce/consume payload pipeline (through())', function(done) {
			var FIELDS = 10;
			var TOTAL = 20;
			var TIMEOUT = 20;
			var count = 0;
			var check = lodash.range(TOTAL);
			var ok = handler.consume(function(msg, info, finish) {
				var writableStream = new streamBuffers.WritableStreamBuffer();
				info.payloadStream
				.on('end', finish)
				.pipe(miss.through(function(chunk, enc, callback) {
					var message = JSON.parse(chunk);
					this.push(message.code + ',');
					callback();
				}))
				.pipe(writableStream)
				.on('finish', function () {
					var text = writableStream.getContentsAsString();
					var list = text.split(',').filter(function(t) {
						return t.length
					}).map(lodash.ary(parseInt, 1));
					assert.sameMembers(list, lodash.range(TOTAL));
					debugx.enabled && debugx('Codes: ', JSON.stringify(list));
					done();
				});
			}, { payloadEnabled: true });
			ok.then(function() {
				var bog = new bogen.BigObjectGenerator({
					numberOfFields: FIELDS, max: TOTAL, timeout: TIMEOUT
				});
				var bos = new bogen.BigObjectStreamify(bog, {objectMode: true});
				debugx.enabled && debugx('produce() - start');
				return handler.produce({}, null, {payloadStream: bos});
			}).then(function() {
				debugx.enabled && debugx('produce() - done');
			}).catch(function(err) {
				debugx.enabled && debugx('produce() - error');
				done(err);
			});
		});
	});
});
