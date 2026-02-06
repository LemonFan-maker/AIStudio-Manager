/**
 * 请求处理器方法混入
 * 包含 processRequest, processOpenAIRequest 以及相关方法
 */

module.exports = function (RequestHandler) {
	const proto = RequestHandler.prototype;

	proto._buildProxyRequest = function (req, requestId) {
		let bodyObj = req.body;
		if (
			this.serverSystem.forceThinking &&
			req.method === "POST" &&
			bodyObj &&
			bodyObj.contents
		) {
			if (!bodyObj.generationConfig) {
				bodyObj.generationConfig = {};
			}
			if (!bodyObj.generationConfig.thinkingConfig) {
				this.logger.info(
					`[Proxy] (Google原生格式) 强制推理已启用，正在注入 thinkingConfig...`
				);
				bodyObj.generationConfig.thinkingConfig = { includeThoughts: true };
			}
		}

		// 强制联网搜索和URL上下文 (Native Google Format)
		if (
			(this.serverSystem.forceWebSearch || this.serverSystem.forceUrlContext) &&
			req.method === "POST" &&
			bodyObj &&
			bodyObj.contents
		) {
			if (!bodyObj.tools) {
				bodyObj.tools = [];
			}
			const toolsToAdd = [];
			if (this.serverSystem.forceWebSearch) {
				const hasSearch = bodyObj.tools.some((t) => t.googleSearch);
				if (!hasSearch) {
					bodyObj.tools.push({ googleSearch: {} });
					toolsToAdd.push("googleSearch");
				}
			}
			if (this.serverSystem.forceUrlContext) {
				const hasUrlContext = bodyObj.tools.some((t) => t.urlContext);
				if (!hasUrlContext) {
					bodyObj.tools.push({ urlContext: {} });
					toolsToAdd.push("urlContext");
				}
			}
			if (toolsToAdd.length > 0) {
				this.logger.info(
					`[Proxy] (Google原生格式) 强制功能已启用，注入工具: [${toolsToAdd.join(", ")}]`
				);
			}
		}

		let requestBody = "";
		if (bodyObj) {
			requestBody = JSON.stringify(bodyObj);
		}

		return {
			path: req.path,
			method: req.method,
			headers: req.headers,
			query_params: req.query,
			body: requestBody,
			request_id: requestId,
			streaming_mode: this.serverSystem.streamingMode,
		};
	};

	proto.processRequest = async function (req, res) {
		const startTime = Date.now();
		let requestStatus = 200;
		let responseBody = null;

		if (this.browserManager) {
			this.browserManager.notifyUserActivity();
		}
		const requestId = this._generateRequestId();
		let queueCancel = null;
		res.on("close", () => {
			if (!res.writableEnded) {
				this.logger.warn(`[Request] 客户端已提前关闭请求 #${requestId} 的连接。`);
				if (queueCancel) queueCancel();
				this._cancelBrowserRequest(requestId);
			}
		});

		const run = async () => {
			if (!this.connectionRegistry.hasActiveConnections()) {
				if (this.isSystemBusy) {
					return this._sendErrorResponse(res, 503, "服务器正在进行内部维护，请稍后重试。");
				}
				this.logger.error("[System] 检测到浏览器WebSocket连接已断开！正在尝试恢复...");
				this.isSystemBusy = true;
				try {
					await this.browserManager.launchOrSwitchContext(this.currentAuthIndex);
					this.logger.info(`[System] 浏览器已成功恢复！`);
				} catch (error) {
					this.logger.error(`[System] 浏览器自动恢复失败: ${error.message}`);
					return this._sendErrorResponse(res, 503, "服务暂时不可用：后端浏览器实例崩溃。");
				} finally {
					this.isSystemBusy = false;
				}
			}

			if (this.isSystemBusy) {
				return this._sendErrorResponse(res, 503, "服务器正在进行内部维护，请稍后重试。");
			}

			const isGenerativeRequest =
				req.method === "POST" &&
				(req.path.includes("generateContent") || req.path.includes("streamGenerateContent"));
			if (this.config.switchOnUses > 0 && isGenerativeRequest) {
				this.usageCount++;
				this.logger.info(`[Request] 生成请求 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses}`);
				if (this.usageCount >= this.config.switchOnUses) {
					this.needsSwitchingAfterRequest = true;
				}
			}

			const proxyRequest = this._buildProxyRequest(req, requestId);
			proxyRequest.is_generative = isGenerativeRequest;
			const messageQueue = this.connectionRegistry.createMessageQueue(requestId);
			const wantsStreamByHeader = req.headers.accept && req.headers.accept.includes("text/event-stream");
			const wantsStreamByPath = req.path.includes(":streamGenerateContent");
			const wantsStream = wantsStreamByHeader || wantsStreamByPath;

			try {
				if (wantsStream) {
					this.logger.info(`[Request] 客户端启用流式传输 (${this.serverSystem.streamingMode})...`);
					if (this.serverSystem.streamingMode === "fake") {
						await this._handlePseudoStreamResponse(proxyRequest, messageQueue, req, res);
					} else {
						await this._handleRealStreamResponse(proxyRequest, messageQueue, res);
					}
				} else {
					proxyRequest.streaming_mode = "fake";
					responseBody = await this._handleNonStreamResponse(proxyRequest, messageQueue, res);
				}
			} catch (error) {
				this._handleRequestError(error, res);
			} finally {
				this.connectionRegistry.removeMessageQueue(requestId);
				if (this.needsSwitchingAfterRequest) {
					this.logger.info(`[Auth] 轮换计数已达到切换阈值，将在后台自动切换账号...`);
					this._switchToNextAuth().catch((err) => {
						this.logger.error(`[Auth] 后台账号切换任务失败: ${err.message}`);
					});
					this.needsSwitchingAfterRequest = false;
				}
			}
		};

		const queueHandle = this._runWithConcurrency(requestId, run);
		if (queueHandle && queueHandle.cancel) queueCancel = queueHandle.cancel;
		if (queueHandle && queueHandle.promise) await queueHandle.promise;

		const duration = Date.now() - startTime;
		if (res.statusCode) requestStatus = res.statusCode;
		this._logTrafficRequest(req, requestStatus, duration, 0, responseBody);
	};

	proto.processOpenAIRequest = async function (req, res) {
		const startTime = Date.now();
		let requestStatus = 200;
		let responseBody = null;
		if (this.browserManager) {
			this.browserManager.notifyUserActivity();
		}
		const requestId = this._generateRequestId();
		let queueCancel = null;
		res.on("close", () => {
			if (!res.writableEnded) {
				this.logger.warn(`[Request] 客户端已提前关闭请求 #${requestId} 的连接。`);
				if (queueCancel) queueCancel();
				this._cancelBrowserRequest(requestId);
			}
		});
		const isOpenAIStream = req.body.stream === true;
		const model = req.body.model || "gemini-1.5-pro-latest";
		const systemStreamMode = this.serverSystem.streamingMode;
		const useRealStream = isOpenAIStream && systemStreamMode === "real";
		let streamUsage = null;
		let streamContent = "";
		let streamReasoning = "";

		const parseSseJson = (chunk) => {
			if (!chunk || typeof chunk !== "string") return null;
			let jsonString = chunk.trim();
			if (jsonString.startsWith("data: ")) {
				jsonString = jsonString.substring(6).trim();
			}
			if (!jsonString || jsonString === "[DONE]") return null;
			try {
				return JSON.parse(jsonString);
			} catch (e) {
				return null;
			}
		};

		const extractUsageFromGoogleChunk = (chunk) => {
			const parsed = parseSseJson(chunk);
			if (!parsed || !parsed.usageMetadata) return null;
			const inputTokens = parsed.usageMetadata.promptTokenCount || 0;
			const outputTokens = parsed.usageMetadata.candidatesTokenCount || 0;
			return {
				prompt_tokens: inputTokens,
				completion_tokens: outputTokens,
				total_tokens: inputTokens + outputTokens,
			};
		};

		const extractUsageFromGoogleStreamBody = (body) => {
			if (!body || typeof body !== "string") return null;
			const parts = body.split("\n\n");
			for (let i = parts.length - 1; i >= 0; i--) {
				const usage = extractUsageFromGoogleChunk(parts[i]);
				if (usage) return usage;
			}
			return null;
		};

		const accumulateStreamContent = (chunk) => {
			const parsed = parseSseJson(chunk);
			if (!parsed || !parsed.choices || !parsed.choices[0]) return;
			const delta = parsed.choices[0].delta || {};
			if (delta.content) streamContent += delta.content;
			if (delta.reasoning_content) streamReasoning += delta.reasoning_content;
			if (parsed.usage) streamUsage = parsed.usage;
		};

		if (this.config.switchOnUses > 0) {
			this.usageCount++;
			this.logger.info(
				`[Request] OpenAI生成请求 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses}`
			);
			if (this.usageCount >= this.config.switchOnUses) {
				this.needsSwitchingAfterRequest = true;
			}
		}

		const run = async () => {
			let googleBody;
			try {
				googleBody = this._translateOpenAIToGoogle(req.body, model);
			} catch (error) {
				this.logger.error(`[Adapter] OpenAI请求翻译失败: ${error.message}`);
				return this._sendErrorResponse(res, 400, "Invalid OpenAI request format.");
			}

			const googleEndpoint = useRealStream ? "streamGenerateContent" : "generateContent";
			const maxAttempts = Math.max(1, this.authSource.availableIndices.length); // 最多尝试次数等于可用账号数
			let attempt = 0;
			let lastError = null;

			while (attempt < maxAttempts) {
				attempt++;
				const isLastAttempt = attempt >= maxAttempts;

				const proxyRequest = {
					path: `/v1beta/models/${model}:${googleEndpoint}`,
					method: "POST",
					headers: { "Content-Type": "application/json" },
					query_params: useRealStream ? { alt: "sse" } : {},
					body: JSON.stringify(googleBody),
					request_id: requestId, // 保持同一个 Request ID，方便日志追踪（虽然可能会有副作用，但MessageQueue是新的）
					is_generative: true,
					streaming_mode: useRealStream ? "real" : "fake",
				};

				// 为每次尝试创建新的 MessageQueue，避免旧数据干扰
				const messageQueue = this.connectionRegistry.createMessageQueue(requestId);

				try {
					this._forwardRequest(proxyRequest);
					const initialMessage = await messageQueue.dequeue();

					if (initialMessage.event_type === "error") {
						const status = initialMessage.status || 500;
						this.logger.warn(`[Adapter] (尝试 ${attempt}/${maxAttempts}) 收到错误: ${status} - ${initialMessage.message}`);

						// 判断是否值得重试 (403: Forbidden, 429: Rate Limit, 5xx: Server Error)
						const isRetryable = status === 403 || status === 429 || status >= 500;

						if (isRetryable && !isLastAttempt) {
							this.logger.info(`[Adapter] 错误可重试，正在自动切换账号并重试...`);
							await this._switchToNextAuth();
							this.connectionRegistry.removeMessageQueue(requestId); // 清理旧队列
							continue; // 重新开始循环
						}

						// 无法重试或最后一次尝试
						this.logger.error(`[Adapter] 请求最终失败，状态码: ${status}`);
						await this._handleRequestFailureAndSwitch(initialMessage, res);

						if (isOpenAIStream) {
							if (!res.writableEnded) {
								res.write(`data: {"error": {"message": "${initialMessage.message}", "code": ${status}}}\n\n`);
								res.write("data: [DONE]\n\n");
								res.end();
							}
						} else {
							this._sendErrorResponse(res, status, initialMessage.message);
						}
						return;
					}

					// --- 成功收到正常响应，跳出重试循环 ---
					if (this.failureCount > 0) {
						this.logger.info(`[Auth] OpenAI接口请求成功 - 失败计数已重置为 0`);
						this.failureCount = 0;
					}

					// === 以下是原始的流式/非流式处理逻辑 (未修改，只是缩进调整) ===
					if (isOpenAIStream) {
						if (!res.headersSent) {
							res.status(200).set({
								"Content-Type": "text/event-stream",
								"Cache-Control": "no-cache",
								"Connection": "keep-alive",
							});
						}

						if (useRealStream) {
							this.logger.info(`[Adapter] OpenAI 流式响应 (Real Mode) 已启动...`);
							let lastGoogleChunk = "";
							const streamState = { inThought: false };

							while (true) {
								const message = await messageQueue.dequeue(300000);
								if (message.type === "STREAM_END") {
									if (streamState.inThought) {
										const closeThoughtPayload = {
											id: `chatcmpl-${requestId}`,
											object: "chat.completion.chunk",
											created: Math.floor(Date.now() / 1000),
											model: model,
											choices: [{ index: 0, delta: { content: "\n</think>\n" }, finish_reason: null }],
										};
										res.write(`data: ${JSON.stringify(closeThoughtPayload)}\n\n`);
									}
									res.write("data: [DONE]\n\n");
									break;
								}
								if (message.data) {
									const translatedChunk = this._translateGoogleToOpenAIStream(message.data, model, streamState);
									if (translatedChunk) {
										res.write(translatedChunk);
										accumulateStreamContent(translatedChunk);
									}
									lastGoogleChunk = message.data;
								}
							}
							if (!streamUsage) {
								streamUsage = extractUsageFromGoogleChunk(lastGoogleChunk);
							}
							responseBody = JSON.stringify({
								stream: true,
								content: streamContent || null,
								reasoning_content: streamReasoning || null,
								usage: streamUsage || null,
							});
						} else {
							this.logger.info(`[Adapter] OpenAI 流式响应 (Fake Mode) 已启动...`);
							let fullBody = "";
							while (true) {
								const message = await messageQueue.dequeue(300000);
								if (message.type === "STREAM_END") break;
								if (message.data) fullBody += message.data;
							}

							const translatedChunk = this._translateGoogleToOpenAIStream(fullBody, model);
							if (translatedChunk) {
								res.write(translatedChunk);
								accumulateStreamContent(translatedChunk);
							}
							if (!streamUsage) {
								streamUsage = extractUsageFromGoogleStreamBody(fullBody);
							}
							res.write("data: [DONE]\n\n");
							responseBody = JSON.stringify({
								stream: true,
								content: streamContent || null,
								reasoning_content: streamReasoning || null,
								usage: streamUsage || null,
							});
						}
					} else {
						// 非流式响应
						let fullBody = "";
						while (true) {
							const message = await messageQueue.dequeue(300000);
							if (message.type === "STREAM_END") break;
							if (message.event_type === "chunk" && message.data) {
								fullBody += message.data;
							}
						}

						const googleResponse = JSON.parse(fullBody);
						const candidate = googleResponse.candidates?.[0];

						let responseContent = "";
						let reasoningContent = "";
						let toolCalls = [];

						if (candidate && candidate.content && Array.isArray(candidate.content.parts)) {
							const imagePart = candidate.content.parts.find((p) => p.inlineData);
							if (imagePart) {
								const image = imagePart.inlineData;
								responseContent = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
							} else {
								candidate.content.parts.forEach((p) => {
									if (p.thought) {
										reasoningContent += p.text || "";
									} else if (p.functionCall) {
										const fnName = p.functionCall.name;
										let args = p.functionCall.args;
										let argsString = typeof args === "string" ? args : JSON.stringify(args || {});
										toolCalls.push({
											id: `call_${this._generateRequestId()}`,
											type: "function",
											function: { name: fnName, arguments: argsString },
										});
									} else {
										responseContent += p.text || "";
									}
								});
							}
						}

						var messageObj = { role: "assistant", content: responseContent };
						if (toolCalls.length > 0) {
							messageObj.tool_calls = toolCalls;
							if (!responseContent) messageObj.content = null;
						}
						if (reasoningContent) {
							messageObj.reasoning_content = reasoningContent;
						}

						const openaiResponse = {
							id: `chatcmpl-${requestId}`,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model: model,
							choices: [
								{
									index: 0,
									message: messageObj || { role: "assistant", content: "" },
									finish_reason: toolCalls.length > 0 ? "tool_calls" : candidate?.finishReason,
								},
							],
						};

						if (googleResponse.usageMetadata) {
							const inputTokens = googleResponse.usageMetadata.promptTokenCount || 0;
							const outputTokens = googleResponse.usageMetadata.candidatesTokenCount || 0;
							openaiResponse.usage = {
								prompt_tokens: inputTokens,
								completion_tokens: outputTokens,
								total_tokens: inputTokens + outputTokens,
							};
						}

						responseBody = JSON.stringify(openaiResponse);
						res.status(200).json(openaiResponse);
					}

					// 成功处理完毕，退出循环
					break;

				} catch (error) {
					this.connectionRegistry.removeMessageQueue(requestId);

					this.logger.warn(`[Adapter] (尝试 ${attempt}/${maxAttempts}) 发生异常: ${error.message}`);
					if (!isLastAttempt) {
						this.logger.info(`[Adapter] 异常可重试，正在自动切换账号...`);
						await this._switchToNextAuth();
						continue;
					}

					this._handleRequestError(error, res);
					break; // 退出循环
				} finally {
					// 这里的 finally 比较棘手，因为如果是 continue，不应该 removeMessageQueue，但我们在 catch 和 if(error) 里手动处理了
					// 如果是 break 出去，需要在最外层清理吗？
					// 我们在 catch 里清理了。在成功路径的最后清理一下更安全。
					if (this.connectionRegistry.createMessageQueue(requestId)) { // 检查是否还存在
						this.connectionRegistry.removeMessageQueue(requestId);
					}
				}
			} // end while

			if (this.needsSwitchingAfterRequest) {
				this.logger.info(`[Auth] OpenAI轮换计数已达到切换阈值，将在后台自动切换账号...`);
				this._switchToNextAuth().catch((err) => {
					this.logger.error(`[Auth] 后台账号切换任务失败: ${err.message}`);
				});
				this.needsSwitchingAfterRequest = false;
			}
			if (!res.writableEnded) res.end();

		};

		const queueHandle = this._runWithConcurrency(requestId, run);
		if (queueHandle && queueHandle.cancel) queueCancel = queueHandle.cancel;
		if (queueHandle && queueHandle.promise) await queueHandle.promise;

		const duration = Date.now() - startTime;
		if (res.statusCode) requestStatus = res.statusCode;
		this._logTrafficRequest(req, requestStatus, duration, 0, responseBody);
	};

	proto._handlePseudoStreamResponse = async function (proxyRequest, messageQueue, req, res) {
		this.logger.info("[Request] 客户端启用流式传输 (fake)，进入伪流式处理模式...");
		res.status(200).set({
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		const connectionMaintainer = setInterval(() => {
			if (!res.writableEnded) res.write(": keep-alive\n\n");
		}, 3000);

		try {
			let lastMessage, requestFailed = false;

			for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
				if (attempt > 1) {
					this.logger.info(`[Request] 请求尝试 #${attempt}/${this.maxRetries}...`);
				}
				this._forwardRequest(proxyRequest);
				try {
					const timeoutPromise = new Promise((_, reject) =>
						setTimeout(() => reject(new Error("Response from browser timed out after 300 seconds")), 300000)
					);
					lastMessage = await Promise.race([messageQueue.dequeue(), timeoutPromise]);
				} catch (timeoutError) {
					this.logger.error(`[Request] 致命错误: ${timeoutError.message}`);
					lastMessage = { event_type: "error", status: 504, message: timeoutError.message };
				}

				if (lastMessage.event_type === "error") {
					if (!(lastMessage.message && lastMessage.message.includes("The user aborted a request"))) {
						this.logger.warn(`[Request] 尝试 #${attempt} 失败: ${lastMessage.status || "未知"} - ${lastMessage.message}`);
					}
					if (attempt < this.maxRetries) {
						await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
						continue;
					}
					requestFailed = true;
				}
				break;
			}

			if (requestFailed) {
				if (lastMessage.message && lastMessage.message.includes("The user aborted a request")) {
					this.logger.info(`[Request] 请求 #${proxyRequest.request_id} 已由用户妥善取消。`);
				} else {
					this.logger.error(`[Request] 所有 ${this.maxRetries} 次重试均失败。`);
					await this._handleRequestFailureAndSwitch(lastMessage, res);
					this._sendErrorChunkToClient(res, `请求最终失败: ${lastMessage.message}`);
				}
				return;
			}

			if (proxyRequest.is_generative && this.failureCount > 0) {
				this.logger.info(`[Auth] 生成请求成功 - 失败计数已重置为 0`);
				this.failureCount = 0;
			}
			const dataMessage = await messageQueue.dequeue();
			const endMessage = await messageQueue.dequeue();
			if (dataMessage.data) {
				res.write(`data: ${dataMessage.data}\n\n`);
			}
			if (endMessage.type !== "STREAM_END") {
				this.logger.warn("[Request] 未收到预期的流结束信号。");
			}
			res.write("data: [DONE]\n\n");
		} catch (error) {
			this._handleRequestError(error, res);
		} finally {
			clearInterval(connectionMaintainer);
			if (!res.writableEnded) res.end();
		}
	};

	proto._handleRealStreamResponse = async function (proxyRequest, messageQueue, res) {
		this.logger.info(`[Request] 请求已派发给浏览器端处理...`);
		this._forwardRequest(proxyRequest);
		const headerMessage = await messageQueue.dequeue();

		if (headerMessage.event_type === "error") {
			if (headerMessage.message && headerMessage.message.includes("The user aborted a request")) {
				this.logger.info(`[Request] 请求 #${proxyRequest.request_id} 已被用户妥善取消。`);
			} else {
				this.logger.error(`[Request] 请求失败，将计入失败统计。`);
				await this._handleRequestFailureAndSwitch(headerMessage, null);
				return this._sendErrorResponse(res, headerMessage.status, headerMessage.message);
			}
			if (!res.writableEnded) res.end();
			return;
		}

		if (proxyRequest.is_generative && this.failureCount > 0) {
			this.logger.info(`[Auth] 生成请求成功 - 失败计数已重置为 0`);
			this.failureCount = 0;
		}

		this._setResponseHeaders(res, headerMessage);
		this.logger.info("[Request] 开始流式传输...");
		try {
			while (true) {
				const dataMessage = await messageQueue.dequeue(30000);
				if (dataMessage.type === "STREAM_END") break;
				if (dataMessage.data) res.write(dataMessage.data);
			}
		} catch (error) {
			if (error.message !== "Queue timeout") throw error;
			this.logger.warn("[Request] 真流式响应超时，可能流已正常结束。");
		} finally {
			if (!res.writableEnded) res.end();
		}
	};

	proto._handleNonStreamResponse = async function (proxyRequest, messageQueue, res) {
		this.logger.info(`[Request] 进入非流式处理模式...`);
		this._forwardRequest(proxyRequest);

		try {
			const headerMessage = await messageQueue.dequeue();
			if (headerMessage.event_type === "error") {
				if (headerMessage.message?.includes("The user aborted a request")) {
					this.logger.info(`[Request] 请求 #${proxyRequest.request_id} 已被用户妥善取消。`);
				} else {
					this.logger.error(`[Request] 浏览器端返回错误: ${headerMessage.message}`);
					await this._handleRequestFailureAndSwitch(headerMessage, null);
				}
				return this._sendErrorResponse(res, headerMessage.status || 500, headerMessage.message);
			}

			let fullBody = "";
			while (true) {
				const message = await messageQueue.dequeue(300000);
				if (message.type === "STREAM_END") break;
				if (message.event_type === "chunk" && message.data) {
					fullBody += message.data;
				}
			}

			if (proxyRequest.is_generative && this.failureCount > 0) {
				this.logger.info(`[Auth] 非流式生成请求成功 - 失败计数已重置为 0`);
				this.failureCount = 0;
			}

			// 智能图片处理
			try {
				let parsedBody = JSON.parse(fullBody);
				let needsReserialization = false;
				const candidate = parsedBody.candidates?.[0];
				if (candidate?.content?.parts) {
					const imagePartIndex = candidate.content.parts.findIndex((p) => p.inlineData);
					if (imagePartIndex > -1) {
						this.logger.info("[Proxy] 检测到Google格式响应中的图片数据，正在转换为Markdown...");
						const imagePart = candidate.content.parts[imagePartIndex];
						const image = imagePart.inlineData;
						const markdownTextPart = { text: `![Generated Image](data:${image.mimeType};base64,${image.data})` };
						candidate.content.parts[imagePartIndex] = markdownTextPart;
						needsReserialization = true;
					}
				}
				if (needsReserialization) {
					fullBody = JSON.stringify(parsedBody);
				}
			} catch (e) {
				this.logger.warn(`[Proxy] 响应体不是有效的JSON: ${e.message}`);
			}

			res.status(headerMessage.status || 200).type("application/json").send(fullBody || "{}");
			this.logger.info(`[Request] 已向客户端发送完整的非流式响应。`);
			return fullBody;
		} catch (error) {
			this._handleRequestError(error, res);
			return null;
		}
	};
};
