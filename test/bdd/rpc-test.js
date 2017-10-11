'use strict';

var Promise = require('bluebird');
var lodash = require('lodash');
var assert = require('chai').assert;
var expect = require('chai').expect;
var debugx = require('debug')('bdd:opflow:rpc');
var opflow = require('../../index');
var appCfg = require('../lab/app-configuration');
var bogen = require('../lab/big-object-generator');
var Loadsync = require('loadsync');

var Fibonacci = require('../lab/fibonacci').Fibonacci;
var fibonacci = require('../lab/fibonacci').fibonacci;

describe('opflow-rpc:', function() {
	this.timeout(1000 * 60 * 60);

	var logCounter = {};
	var LogTracer = opflow.LogTracer;
	before(function() {
		LogTracer.clearStringifyInterceptors();
		LogTracer.addStringifyInterceptor(function(logobj) {
			appCfg.updateCounter(logCounter, [{
				message: 'request() - make a request',
				fieldName: 'rpcRequestTotal'
			}, {
				message: 'request() - receive final result',
				fieldName: 'rpcRequestReturned'
			}, {
				message: 'Task is timeout',
				fieldName: 'extractResultTimeout'
			}, {
				message: 'Task is done',
				fieldName: 'extractResultCompleted'
			}, {
				message: 'Task is failed',
				fieldName: 'extractResultFailed'
			}], logobj);
		});
	});

	after(function() {
		LogTracer.clearStringifyInterceptors();
	});

	describe('multiple masters with explicit responseName:', function() {
		var masters, workers;

		before(function() {
			masters = lodash.range(2).map(function() {
				return new opflow.RpcMaster(appCfg.extend({
					routingKey: 'tdd-opflow-rpc',
					responseName: 'tdd-opflow-response',
					monitorTimeout: 2000,
					progressEnabled: false,
					autoinit: false
				}))
			});
		});

		beforeEach(function(done) {
			appCfg.checkSkip.call(this);
			done();
		});

		afterEach(function(done) {
			var result = [];
			masters.forEach(function(master) {
				result.push(master.close());
			});
			Promise.all(result).then(lodash.ary(done, 0));
		});

		it('should return exceeding limit error when more than 1 masters use the same responseQueue', function(done) {
			var series = Promise.mapSeries(masters, function(master) {
				return master.ready();
			});
			series.then(function() {
				done('should return exceeding limit error');
			}).catch(function(error) {
				done(null);
			});
		});
	});

	describe('single master - single worker:', function() {
		var master, worker;

		before(function() {
			master = new opflow.RpcMaster(appCfg.extend({
				routingKey: 'tdd-opflow-rpc',
				responseName: 'tdd-opflow-response',
				autoinit: false
			}));
			worker = new opflow.RpcWorker(appCfg.extend({
				routingKey: 'tdd-opflow-rpc',
				responseName: 'tdd-opflow-response',
				operatorName: 'tdd-opflow-operator',
				autoinit: false
			}));
		});

		beforeEach(function(done) {
			appCfg.checkSkip.call(this);
			Promise.all([ master.ready() ]).then(lodash.ary(done, 0));
		});

		afterEach(function(done) {
			Promise.all([
				master.close(),
				worker.close()
			]).then(lodash.ary(done, 0));
		});

		it('master request, worker process and response', function(done) {
			var input = { number: 20 };
			Promise.all([worker.process('fibonacci', taskWorker)]).then(function() {
				return master.request('fibonacci', input, {
					requestId: 'one-master-single-worker-' + (new Date()).toISOString()
				}).then(function(job) {
					return processTask(job);
				}).then(function(trail) {
					return {input, trail};
				});
			}).then(function(result) {
				validateResult(result);
				done(null);
			}).catch(function(error) {
				done(error);
			});
		});
	});

	describe('single master - multiple workers:', function() {
		var master, worker1, worker2;

		before(function() {
			master = new opflow.RpcMaster(appCfg.extend({
				routingKey: 'tdd-opflow-rpc',
				responseName: 'tdd-opflow-response',
				monitorTimeout: 6000,
				autoinit: false
			}));
			var cfg = appCfg.extend({
				routingKey: 'tdd-opflow-rpc',
				responseName: 'tdd-opflow-response',
				operatorName: 'tdd-opflow-operator',
				autoinit: false
			});
			worker1 = new opflow.RpcWorker(cfg);
			worker2 = new opflow.RpcWorker(cfg);
		});

		beforeEach(function(done) {
			appCfg.checkSkip.call(this);
			Promise.all([
				master.ready(),
				worker1.ready(),
				worker2.ready()
			]).then(lodash.ary(done, 0));
		});

		afterEach(function(done) {
			Promise.all([
				master.close(),
				worker1.close(),
				worker2.close()
			]).then(lodash.ary(done, 0));
		});

		it('master request to multiple workers, it should return correct results', function(done) {
			logCounter = {};
			var data = [10, 8, 20, 15, 11, 19, 25, 12, 16, 35, 34, 28].map(function(n) { return { number: n }});
			Promise.all([
				worker1.process('fibonacci', taskWorker),
				worker2.process('fibonacci', taskWorker)
			]).then(function() {
				return Promise.map(data, function(input) {
					return master.request('fibonacci', input).then(function(job) {
						return processTask(job).then(function(trail) {
							return { input: input, trail: trail }
						});
					});
				}, {concurrency: 4});
			}).then(function(results) {
				lodash.forEach(results, validateResult);
				debugx.enabled && debugx('LogCounter: %s', JSON.stringify(logCounter));
				assert.equal(logCounter.rpcRequestTotal, data.length);
				assert.equal(logCounter.rpcRequestTotal, logCounter.rpcRequestReturned);
				done(null);
			}).catch(function(error) {
				done(error);
			});
		});
	});

	describe('bypass unmanaged exception:', function() {
		var master, worker1, worker2;

		before(function() {
			master = new opflow.RpcMaster(appCfg.extend({
				routingKey: 'tdd-opflow-rpc',
				responseName: 'tdd-opflow-response',
				monitorTimeout: 5000,
				autoinit: false
			}));
			var cfg = appCfg.extend({
				routingKey: 'tdd-opflow-rpc',
				responseName: 'tdd-opflow-response',
				operatorName: 'tdd-opflow-operator',
				autoinit: false
			});
			worker1 = new opflow.RpcWorker(cfg);
			worker2 = new opflow.RpcWorker(cfg);
		});

		beforeEach(function(done) {
			appCfg.checkSkip.call(this);
			Promise.all([
				master.ready(),
				worker1.ready(),
				worker2.ready()
			]).then(lodash.ary(done, 0));
		});

		afterEach(function(done) {
			Promise.all([
				master.close(),
				worker1.close(),
				worker2.close()
			]).then(lodash.ary(done, 0));
		});

		it('should bypass unmanged exception, workers are still alive', function(done) {
			logCounter = {};
			var data = [10, 8, 20, 15, 11, 19, 60, 25, 12, 77, 16, 35, 50, 34, 28].map(function(n) { return { number: n }});
			var taskRejectValues = function(body, headers, response) {
				debugx.enabled && debugx('Request[%s] receives: %s', headers.requestId, body);
				body = JSON.parse(body);
				response.emitStarted();
				if (body.number == 60) throw new Error('failed with: ' + body.number);
				var fibonacci = new Fibonacci(body);
				while(fibonacci.next()) {
					var r = fibonacci.result();
					response.emitProgress(r.step, r.number);
					if (body.number == 77 && r.step > 40) {
						throw new Error('failed with: ' + body.number);
					}
				};
				if (body.number == 50) throw new Error('failed with: ' + body.number);
				response.emitCompleted(fibonacci.result());
			}
			Promise.all([
				worker1.process('fibonacci', taskRejectValues),
				worker2.process('fibonacci', taskRejectValues)
			]).then(function() {
				return Promise.map(data, function(input) {
					return master.request('fibonacci', input).then(function(job) {
						return job.extractResult();
					});
				}, {concurrency: 4});
			}).then(function(results) {
				debugx.enabled && debugx('LogCounter: %s', JSON.stringify(logCounter));
				assert.equal(logCounter.rpcRequestTotal, data.length);
				assert.equal(logCounter.rpcRequestReturned, data.length - 3);
				assert.equal(logCounter.extractResultTimeout, 3);
				assert.equal(logCounter.extractResultCompleted, data.length - 3);
				assert.equal(results.length, data.length);
				Promise.reduce(results, function(acc, result) {
					if (result.completed) acc.completed += 1;
					return acc;
				}, { completed: 0 }).then(function(stats) {
					assert.equal(stats.completed, data.length - 3);
					debugx.enabled && debugx('Success total: %s', stats.completed);
					done(null);
				});
			}).catch(function(error) {
				done(error);
			});
		});
	});

	describe('mass RPC requests sending and receiving:', function() {
		var total = 1000;
		var master, worker1, worker2;

		before(function() {
			master = new opflow.RpcMaster(appCfg.extend({
				routingKey: 'tdd-opflow-rpc',
				responseName: 'tdd-opflow-response',
				monitorTimeout: 10 * total,
				progressEnabled: false,
				autoinit: false
			}));
			var cfg = appCfg.extend({
				routingKey: 'tdd-opflow-rpc',
				responseName: 'tdd-opflow-response',
				operatorName: 'tdd-opflow-operator',
				autoinit: false
			});
			worker1 = new opflow.RpcWorker(cfg);
			worker2 = new opflow.RpcWorker(cfg);
		});

		beforeEach(function(done) {
			appCfg.checkSkip.call(this);
			Promise.all([
				master.ready(),
				worker1.ready(),
				worker2.ready()
			]).then(lodash.ary(done, 0));
		});

		afterEach(function(done) {
			Promise.all([
				master.close(),
				worker1.close(),
				worker2.close()
			]).then(lodash.ary(done, 0));
		});

		it('SM/MW - should bypass unmanged exception, workers are still alive', function(done) {
			logCounter = {};
			var bypass = [11, 14, 15, 18, 20, 24, 25, 26, 47];
			var acc = {total: 0, completed: 0, failed: 0, timeout: 0, skipped: 0};
			var taskRejectValues = function(body, headers, response) {
				debugx.enabled && debugx('Request[%s] receives: %s', headers.requestId, body);
				body = JSON.parse(body);
				var pos = bypass.indexOf(body.number);
				response.emitStarted();
				if (0 <= pos && pos < 3) {
					acc.skipped += 1;
					throw new Error('failed with: ' + body.number);
				}
				var fibonacci = new Fibonacci(body);
				while(fibonacci.next()) {
					var r = fibonacci.result();
					response.emitProgress(r.step, r.number);
					if (3 <= pos && pos < 6 && r.step > 5) {
						acc.skipped += 1;
						throw new Error('failed with: ' + body.number);
					}
				};
				if (6 <= pos) {
					acc.skipped += 1;
					throw new Error('failed with: ' + body.number);
				}
				response.emitCompleted(fibonacci.result());
			}
			Promise.all([
				worker1.process('fibonacci', taskRejectValues),
				worker2.process('fibonacci', taskRejectValues)
			]).then(function() {
				return Promise.map(lodash.range(total), function(count) {
					acc.total += 1;
					return master.request('fibonacci', {
						number: lodash.random(10, 50)
					}).then(function(job) {
						return job.extractResult();
					}).then(function(result) {
						debugx.enabled && debugx('#%s: %s', count, result.status);
						if (result.completed) acc.completed += 1;
						if (result.failed) acc.failed += 1;
						if (result.timeout) acc.timeout += 1;
						return 1;
					});
				}, {concurrency: 10});
			}).then(function(results) {
				debugx.enabled && debugx('Result: %s', JSON.stringify(acc));
				assert.equal(acc.total, total);
				assert.equal(acc.completed + acc.failed + acc.timeout, total);
				assert.equal(acc.timeout, acc.skipped);
				debugx.enabled && debugx('LogCounter: %s', JSON.stringify(logCounter));
				assert.equal(logCounter.rpcRequestTotal, total);
				assert.equal(logCounter.rpcRequestReturned, logCounter.extractResultCompleted);
				assert.equal(logCounter.rpcRequestReturned + logCounter.extractResultTimeout, logCounter.rpcRequestTotal);
				done();
			}).catch(function(error) {
				done(error);
			});
		});
	});

	describe('multiple masters / multiple workers:', function() {
		var total = 1000;
		var masters, workers;

		before(function() {
			masters = lodash.range(5).map(function() {
				return new opflow.RpcMaster(appCfg.extend({
					routingKey: 'tdd-opflow-rpc',
					monitorTimeout: 10 * total,
					progressEnabled: false,
					autoinit: false
				}))
			});
			workers = lodash.range(5).map(function() {
				return new opflow.RpcWorker(appCfg.extend({
					routingKey: 'tdd-opflow-rpc',
					responseName: 'tdd-opflow-response',
					operatorName: 'tdd-opflow-operator',
					autoinit: false
				}));
			});
		});

		beforeEach(function(done) {
			appCfg.checkSkip.call(this);
			Promise.mapSeries(lodash.concat(masters, workers), function(handler) {
				return handler.ready();
			}).then(lodash.ary(done, 0));
		});

		afterEach(function(done) {
			var result = [];
			masters.forEach(function(master) {
				result.push(master.close());
			});
			workers.forEach(function(worker) {
				result.push(worker.close());
			});
			Promise.all(result).then(lodash.ary(done, 0));
		});

		it('MM/MW - should bypass unmanged exception, workers are still alive', function(done) {
			logCounter = {};
			var bypass = [11, 14, 15, 18, 20, 24, 25, 26, 47];
			var acc = {total: 0, completed: 0, failed: 0, timeout: 0, skipped: 0};
			var taskRejectValues = function(body, headers, response) {
				debugx.enabled && debugx('Request[%s] receives: %s', headers.requestId, body);
				body = JSON.parse(body);
				var pos = bypass.indexOf(body.number);
				response.emitStarted();
				if (0 <= pos && pos < 3) {
					acc.skipped += 1;
					throw new Error('failed with: ' + body.number);
				}
				var fibonacci = new Fibonacci(body);
				while(fibonacci.next()) {
					var r = fibonacci.result();
					response.emitProgress(r.step, r.number);
					if (3 <= pos && pos < 6 && r.step > 5) {
						acc.skipped += 1;
						throw new Error('failed with: ' + body.number);
					}
				};
				if (6 <= pos) {
					acc.skipped += 1;
					throw new Error('failed with: ' + body.number);
				}
				response.emitCompleted(fibonacci.result());
			}
			Promise.map(workers, function(worker) {
				return worker.process('fibonacci', taskRejectValues)
			}).then(function() {
				return Promise.map(lodash.range(total), function(count) {
					acc.total += 1;
					var ind = lodash.random(masters.length - 1);
					return masters[ind].request('fibonacci', {
						number: lodash.random(10, 50)
					}).then(function(job) {
						return job.extractResult();
					}).then(function(result) {
						debugx.enabled && debugx('#%s: %s', count, result.status);
						if (result.completed) acc.completed += 1;
						if (result.failed) acc.failed += 1;
						if (result.timeout) acc.timeout += 1;
						return 1;
					});
				}, {concurrency: 30});
			}).then(function(results) {
				debugx.enabled && debugx('Result: %s', JSON.stringify(acc));
				assert.equal(acc.total, total);
				assert.equal(acc.completed + acc.failed + acc.timeout, total);
				assert.equal(acc.timeout, acc.skipped);
				debugx.enabled && debugx('LogCounter: %s', JSON.stringify(logCounter));
				assert.equal(logCounter.rpcRequestTotal, total);
				assert.equal(logCounter.rpcRequestReturned, logCounter.extractResultCompleted);
				assert.equal(logCounter.rpcRequestReturned + logCounter.extractResultTimeout, logCounter.rpcRequestTotal);
				done();
			}).catch(function(error) {
				done(error);
			});
		});
	});
});

var taskWorker = function(body, headers, response) {
	debugx.enabled && debugx('Request[%s] worker receives: %s', headers.requestId, body);
	response.emitStarted();
	var fibonacci = new Fibonacci(JSON.parse(body));
	while(fibonacci.next()) {
		var r = fibonacci.result();
		response.emitProgress(r.step, r.number);
	};
	response.emitCompleted(fibonacci.result());
};

var processTask = function(job) {
	var requestID = job.requestId;
	return new Promise(function(onResolved, onRejected) {
		var stepTracer = [];
		job.on('started', function(info) {
			stepTracer.push({ event: 'started', data: info});
			debugx.enabled && debugx('Request[%s] started', requestID);
		}).on('progress', function(percent, data) {
			stepTracer.push({ event: 'progress', data: {percent: percent}});
			debugx.enabled && debugx('Request[%s] progress: %s', requestID, percent);
		}).on('failed', function(error) {
			stepTracer.push({ event: 'failed', data: error});
			debugx.enabled && debugx('Request[%s] failed, error: %s', requestID, JSON.stringify(error));
			onRejected(error);
		}).on('completed', function(result) {
			stepTracer.push({ event: 'completed', data: result});
			debugx.enabled && debugx('Request[%s] done, result: %s', requestID, JSON.stringify(result));
			onResolved(stepTracer);
		});
	});
}

var validateResult = function(result) {
	var input = result.input, trail = result.trail;
	assert.equal(trail.length, 1 + input.number + 1);
	assert.equal(trail[0].event, 'started');
	for(var i=1; i<=input.number; i++) {
		assert.equal(trail[i].event, 'progress');
	}
	assert.equal(trail[input.number + 1].event, 'completed');
	assert.equal(trail[input.number + 1].data.number, input.number);
	assert.equal(trail[input.number + 1].data.value, fibonacci(input.number));
}