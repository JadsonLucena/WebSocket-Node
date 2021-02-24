const EventEmitter = require('events');
const crypto = require('crypto');

class WebSocket extends EventEmitter {

    #allowOrigin;
    #clients;
    #encoding;
    #limitByIP;
    #maxPayload;
    #pongTimeout;

    constructor(server, {
        allowOrigin = null, // The value should be similar to what Access-Control-Allow-Origin would receive
        pingDelay = 1000 * 60 * 3,
        encoding = 'utf8',
        limitByIP = 256, // IP connection limit (Must be greater than zero)
        maxPayload = 131072 * 20, // (Max chrome 131072 bytes by frame)
        pongTimeout = 5000
    } = {}) {

        super({captureRejections: true});

        this.setMaxListeners(0);

        this.#allowOrigin = allowOrigin;
        this.#clients = {};
        this.#encoding = encoding;
        this.#limitByIP = limitByIP;
        this.#maxPayload = maxPayload;
        this.#pongTimeout = pongTimeout;

        server.on('upgrade', async (request, socket, head) => {

            request.headers['origin'] = (request.headers['origin'] || request.headers['sec-webSocket-origin']).trim();

            if (request.headers['upgrade'].trim() != 'websocket') {

                socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                socket.destroy();

            } else if (!/^(8|13)$/.test(+request.headers['sec-websocket-version'].trim())) {

                socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13, 8\r\n\r\n');
                socket.destroy();

            } if (!request.headers['origin'] || (!request.headers['origin'].includes(request.headers['host'].trim()) && (!this.#allowOrigin || (this.#allowOrigin != '*' && !this.#allowOrigin.includes(request.headers['origin']))))) {

                socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
                socket.destroy();

            } else if (this.#limitByIP >= 1 && Object.keys(this.#clients).filter(clientId => this.#clients[clientId].socket.remoteAddress == socket.remoteAddress).length + 1 > this.#limitByIP) {

                socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
                socket.destroy();

            } else {

                socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash('sha1').update(request.headers['sec-websocket-key'].trim() +'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')}\r\n\r\n`);
                socket.setTimeout(0);


                /* Begin generate unique ID */
                let clientId;
                while ((clientId = crypto.randomBytes(5).toString("hex")) in this.#clients);
                /* End generate unique ID */


                this.#clients[clientId] = {
                    socket: socket,
                    ping: {
                        timer: null,
                        content: crypto.randomBytes(5).toString('hex')
                    },
                    pong: {
                        timer: null,
                        timerSecurity: null
                    }
                };


                let next = Buffer.alloc(0);
                socket.on('data', (data) => {

                    if (clientId in this.#clients) {

                        data = [this.#decode(Buffer.concat([next, data]))];

                        let index = 0;

                        // Ensures that until the last frame is processed, if it comes concatenated
                        while (true) {

                            if (data[index] && !data[index].waiting && data[index].next.length) {

                                data.push(this.#decode(data[index].next));
                                
                                index++;

                                if (data[index] && !data[index].waiting && (data[index].FIN && data[index].payloadData.length == data[index].payloadLength)) {

                                    data[index - 1].next = Buffer.alloc(0);

                                } else {

                                    break;

                                }

                            } else {

                                break;

                            }

                        }

                        // Ensures that it will only follow when the entire frame arrives
                        if (data[index] && data[index].waiting) {

                            next = data[index].next;

                        } else {

                        }

                    }

                });

            }

        });

    }

    #decode(payload) { // Input buffer binary

        let FIN = (payload[0] & 0x80) == 0x80; // 1 bit
        let RSV1 = payload[0] & 0x40; // 1 bit
        let RSV2 = payload[0] & 0x20; // 1 bit
        let RSV3 = payload[0] & 0x10; // 1 bit
        let opcode = payload[0] & 0x0F; // Low four bits
        let MASK = (payload[1] & 0x80) == 0x80; // 1 bit

        let payloadLength = payload[1] & 0x7F; // Low 7 bits, 7+16 bits, or 7+64 bits
        let maskingKey = ''; // 0 or 4 bytes
        let payloadData = Buffer.alloc(0); // (x+y) bytes
        let extensionData = ''; // x bytes
        let applicationData = ''; // y bytes


        if (
            // RSV1 || RSV2 || RSV3 ||
            // ((opcode >= 3 && opcode <= 7) || opcode > 10) ||
        !MASK) {

            return null;

        } else {

            let index = 2;

            if (payloadLength == 126) {

                // if (payload.length < 2) {
                //     return null;
                // }

                payloadLength = payload.readUInt16BE(2);
                index += 2;

            } else if (payloadLength == 127) {

                // if (payload.length < 8) {
                //     return null;
                // }

                if (payload.readUInt32BE(2) != 0) { // Discard high 4 bits because this server cannot handle huge lengths

                    return null;

                }

                payloadLength = payload.readUInt32BE(6);
                index += 8;

            }

            let waiting = false;
            let next = null;
            if (payload.length >= index + 4 + payloadLength) {

                maskingKey = payload.slice(index, index + 4);

                index += 4;

                payloadData = payload.slice(index, index + payloadLength);
                for (let i = 0; i < payloadData.length; i++) {

                    payloadData[i] = payloadData[i] ^ maskingKey[i % 4];

                }

                next = payload.slice(index + payloadLength);

            } else {

                waiting = true;
                next = payload;

            }

            return {
                'FIN': FIN,
                'opcode': opcode,
                'payloadLength': payloadLength,
                'payloadData': payloadData,
                'next': next,
                'waiting': waiting
            };

        }

    }

    #encode(message, opcode) {

        let size = message.length;

        let buffer;
        if (size <= 125) {

            buffer = Buffer.alloc(size + 2 + 0);            
            buffer.writeUInt8(0x80 | opcode, 0);
            buffer.writeUInt8(size, 1);
            message.copy(buffer, 2);

        } else if (size <= 65535) {

            buffer = Buffer.alloc(size + 2 + 2);            
            buffer.writeUInt8(0x80 | opcode, 0);
            buffer.writeUInt8(126, 1);
            buffer.writeUInt16BE(size, 2);
            message.copy(buffer, 4);

        } else { // This implementation cannot handle lengths greater than 2^32

            buffer = Buffer.alloc(size + 2 + 8);            
            buffer.writeUInt8(0x80 | opcode, 0);
            buffer.writeUInt8(127, 1);
            buffer.writeUInt32BE(0, 2);
            buffer.writeUInt32BE(size, 6);
            message.copy(buffer, 10);

        }

        return buffer;

    }

};