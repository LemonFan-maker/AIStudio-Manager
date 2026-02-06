/**
 * 消息队列模块
 * 用于管理异步消息的入队和出队
 */

const { EventEmitter } = require("events");

class MessageQueue extends EventEmitter {
    constructor(timeoutMs = 600000) {
        super();
        this.messages = [];
        this.waitingResolvers = [];
        this.defaultTimeout = timeoutMs;
        this.closed = false;
    }

    enqueue(message) {
        if (this.closed) return;
        if (this.waitingResolvers.length > 0) {
            const resolver = this.waitingResolvers.shift();
            resolver.resolve(message);
        } else {
            this.messages.push(message);
        }
    }

    async dequeue(timeoutMs = this.defaultTimeout) {
        if (this.closed) {
            throw new Error("Queue is closed");
        }
        return new Promise((resolve, reject) => {
            if (this.messages.length > 0) {
                resolve(this.messages.shift());
                return;
            }
            const resolver = { resolve, reject };
            this.waitingResolvers.push(resolver);
            const timeoutId = setTimeout(() => {
                const index = this.waitingResolvers.indexOf(resolver);
                if (index !== -1) {
                    this.waitingResolvers.splice(index, 1);
                    reject(new Error("Queue timeout"));
                }
            }, timeoutMs);
            resolver.timeoutId = timeoutId;
        });
    }

    close() {
        this.closed = true;
        this.waitingResolvers.forEach((resolver) => {
            clearTimeout(resolver.timeoutId);
            resolver.reject(new Error("Queue closed"));
        });
        this.waitingResolvers = [];
        this.messages = [];
    }
}

module.exports = { MessageQueue };
