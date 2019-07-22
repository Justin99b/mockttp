import _ = require("lodash");
import http = require('http');
import portfinder = require('portfinder');
import { getLocal, Mockttp } from "../..";
import request = require("request-promise-native");
import { expect, nodeOnly, getDeferred, Deferred } from "../test-utils";
import { generateCACertificate } from "../../src/util/tls";
import { isLocalIPv6Available } from "../../src/util/socket-util";

const INITIAL_ENV = _.cloneDeep(process.env);

nodeOnly(() => {
    describe("Mockttp when used as a proxy with `request`", function () {

        let server: Mockttp;
        let remoteServer = getLocal();

        beforeEach(async () => {
            await remoteServer.start();
        });

        afterEach(async () => {
            await server.stop();
            await remoteServer.stop();
            process.env = INITIAL_ENV;
        });

        describe("with a default config", () => {

            beforeEach(async () => {
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            it("should mock proxied HTTP with request + process.env", async () => {
                await server.get("http://example.com/endpoint").thenReply(200, "mocked data");

                let response = await request.get("http://example.com/endpoint");
                expect(response).to.equal("mocked data");
            });

            it("should be able to pass through requests", async () => {
                await server.get("http://example.com/").thenPassThrough();

                let response = await request.get("http://example.com/");
                expect(response).to.include(
                    "This domain is established to be used for illustrative examples in documents."
                );
            });

            it("should be able to pass through request headers", async () => {
                await server.get("http://example.com/").thenPassThrough();

                let response = await request.get({
                    uri: "http://example.com/",
                    resolveWithFullResponse: true
                });

                expect(response.headers['content-type']).to.equal('text/html; charset=UTF-8');
            });

            it("should be able to pass through requests with a body", async () => {
                await remoteServer.anyRequest().thenCallback((req) => ({ status: 200, body: req.body.text }));
                await server.post(remoteServer.url).thenPassThrough();

                let response = await request.post({
                    url: remoteServer.url,
                    json: { "test": true }
                });

                expect(response).to.deep.equal({ "test":true });
            });

            it("should be able to pass through requests with a body buffer", async () => {
                await remoteServer.anyRequest().thenCallback((req) => ({
                    status: 200,
                    body: req.body.buffer
                }));
                await server.post(remoteServer.url).thenPassThrough();

                let response = await request.post({
                    url: remoteServer.url,
                    json: { "test": true }
                });

                expect(response).to.deep.equal({ "test": true });
            });

            it("should be able to pass through requests with parameters", async () => {
                await remoteServer.anyRequest().thenCallback((req) => ({ status: 200, body: req.url }));
                await server.get(remoteServer.urlFor('/get')).thenPassThrough();

                let response = await request.get(remoteServer.urlFor('/get?a=b'));

                expect(response).to.equal('/get?a=b');
            });

            it("should be able to verify requests passed through with a body", async () => {
                await remoteServer.post('/post').thenReply(200);
                const endpointMock = await server.post(remoteServer.urlFor('/post')).thenPassThrough();

                await request.post({
                    url: remoteServer.urlFor('/post'),
                    json: { "test": true }
                });

                const seenRequests = await endpointMock.getSeenRequests();
                expect(seenRequests.length).to.equal(1);
                expect(await seenRequests[0].body.text).to.equal('{"test":true}');
            });

            it("should successfully pass through non-proxy requests with a host header", async () => {
                await remoteServer.get('/').thenReply(200, 'remote server');
                server.anyRequest().thenPassThrough();
                process.env = INITIAL_ENV;

                let response = await request.get(server.urlFor("/"), {
                    headers: { host: `localhost:${remoteServer.port}`  }
                });

                expect(response).to.equal('remote server');
            });

            it("should be able to rewrite a request's method", async () => {
                await remoteServer.get('/').thenReply(200, 'GET');
                await remoteServer.post('/').thenReply(200, 'POST');

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: () => ({ method: 'POST' })
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.include("POST");
            });

            it("should be able to rewrite a request's URL", async () => {
                await remoteServer.get('/').thenReply(200, 'Root');
                await remoteServer.get('/endpoint').thenReply(200, '/endpoint');

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: (req) => ({ url: req.url.replace(/\/$/, '/endpoint') })
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.include("/endpoint");
            });

            it("should be able to mutatively rewrite a request's headers", async () => {
                await remoteServer.get('/rewrite').thenCallback((req) => ({
                    status: 200,
                    json: req.headers
                }));

                await server.get(remoteServer.urlFor("/rewrite")).thenPassThrough({
                    beforeRequest: (req) => {
                        req.headers['x-test-header'] = 'test';
                        return req;
                    }
                });

                let response = await request.get(remoteServer.urlFor("/rewrite"));
                expect(JSON.parse(response)['x-test-header']).to.equal("test");
            });

            describe("with an IPv6-only server", () => {
                if (!isLocalIPv6Available) return;

                let ipV6Port: number;
                let ipV6Server: http.Server;
                let requestReceived: Deferred<void>;

                beforeEach(async () => {
                    requestReceived = getDeferred<void>()
                    ipV6Port = await portfinder.getPortPromise();
                    ipV6Server = http.createServer((_req, res) => {
                        requestReceived.resolve();
                        res.writeHead(200);
                        res.end("OK");
                    });

                    return new Promise((resolve, reject) => {
                        ipV6Server.listen({ host: '::1', family: 6, port: ipV6Port }, resolve);
                        ipV6Server.on('error', reject);
                    });
                });

                afterEach(() => new Promise((resolve, reject) => {
                    ipV6Server.close((error) => {
                        if (error) reject();
                        else resolve();
                    });
                }));

                it("correctly forwards requests to the IPv6 port", async () => {
                    server.anyRequest().thenPassThrough();

                    // Localhost here will be ambiguous - we're expecting Mockttp to work it out
                    let response = await request.get(`http://localhost:${ipV6Port}`);
                    await requestReceived;

                    expect(response).to.equal("OK");
                });

            });
        });

        describe("with an HTTPS config", () => {
            beforeEach(async () => {
                server = getLocal({
                    https: {
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem'
                    }
                });

                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            describe("using request + process.env", () => {
                it("should mock proxied HTTP", async () => {
                    await server.get("http://example.com/endpoint").thenReply(200, "mocked data");

                    let response = await request.get("http://example.com/endpoint");
                    expect(response).to.equal("mocked data");
                });

                it("should mock proxied HTTPS", async () => {
                    await server.get("https://example.com/endpoint").thenReply(200, "mocked data");

                    let response = await request.get("https://example.com/endpoint");
                    expect(response).to.equal("mocked data");
                });

                it("should mock proxied HTTPS with a specific port", async () => {
                    await server.get("https://example.com:1234/endpoint").thenReply(200, "mocked data");

                    let response = await request.get("https://example.com:1234/endpoint");
                    expect(response).to.equal("mocked data");
                });

                describe("given an untrusted upstream certificate", () => {

                    let badServer: Mockttp;
                    const untrustedCACert = generateCACertificate({ bits: 1024 });

                    beforeEach(async () => {
                        badServer = getLocal({ https: await untrustedCACert });
                        await badServer.start();
                    });

                    afterEach(() => badServer.stop());

                    it("should refuse to pass through requests", async () => {
                        await badServer.anyRequest().thenReply(200);

                        await server.anyRequest().thenPassThrough();

                        let response = await request.get(badServer.url, {
                            resolveWithFullResponse: true,
                            simple: false
                        });

                        expect(response.statusCode).to.equal(502);
                    });

                    it("should allow passing through requests if the host is specifically listed", async () => {
                        await badServer.anyRequest().thenReply(200);

                        await server.anyRequest().thenPassThrough({
                            ignoreHostCertificateErrors: ['localhost']
                        });

                        let response = await request.get(badServer.url, {
                            resolveWithFullResponse: true,
                            simple: false
                        });

                        expect(response.statusCode).to.equal(200);
                    });

                    it("should allow passing through requests if a non-matching host is specifically listed", async () => {
                        await badServer.anyRequest().thenReply(200);

                        await server.get(badServer.urlFor('/')).thenPassThrough({
                            ignoreHostCertificateErrors: ['differenthost']
                        });

                        let response = await request.get(badServer.url, {
                            resolveWithFullResponse: true,
                            simple: false
                        });

                        expect(response.statusCode).to.equal(502);
                    });
                });
            });
        });

        describe("when configured to forward requests to a different location", () => {

            beforeEach(async () => {
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);

                expect(remoteServer.port).to.not.equal(server.port);
            });

            it("forwards to the location specified in the rule builder", async () => {
                await remoteServer.anyRequest().thenReply(200, "forwarded response");
                await server.anyRequest().thenForwardTo(remoteServer.url);

                let response = await request.get(server.urlFor("/"));

                expect(response).to.equal('forwarded response');
            });

            it("uses the path portion from the original request url", async () => {
                let remoteEndpointMock = await remoteServer.anyRequest().thenReply(200, "mocked data");
                await server.anyRequest().thenForwardTo(remoteServer.url);

                await request.get(server.urlFor("/get"));

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].path).to.equal("/get");
            });

            it("throws an error if the forwarding URL contains a path", async () => {
                const locationWithPath = 'http://localhost:1234/pathIsNotAllowed';

                await expect(server.anyRequest().thenForwardTo(locationWithPath))
                .to.be.rejectedWith(/Did you mean http:\/\/localhost:1234\?$/g);
            });
        });
    });
});