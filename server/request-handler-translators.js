/**
 * 请求处理器翻译器混入
 * 包含 OpenAI 和 Google 格式之间的翻译方法
 */

module.exports = function (RequestHandler) {
    const proto = RequestHandler.prototype;

    proto._translateOpenAIToGoogle = function (openaiBody, modelName = "") {
        this.logger.info("[Adapter] 开始将OpenAI请求格式翻译为Google格式...");

        let systemInstruction = null;
        const googleContents = [];

        // Function Calling / Tools 预处理
        const openaiTools = Array.isArray(openaiBody.tools) ? openaiBody.tools : [];
        const legacyFunctions = Array.isArray(openaiBody.functions) ? openaiBody.functions : [];
        const functionDeclarations = [];

        // 清理 parameters，移除不兼容的字段
        const cleanParameters = (params) => {
            if (!params || typeof params !== "object") {
                return { type: "object" };
            }
            const cleaned = { ...params };
            delete cleaned.$schema;
            delete cleaned.$id;
            delete cleaned.$ref;
            delete cleaned.$comment;
            delete cleaned.definitions;
            return cleaned;
        };

        openaiTools.forEach((tool) => {
            if (tool && tool.type === "function" && tool.function?.name) {
                functionDeclarations.push({
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: cleanParameters(tool.function.parameters),
                });
            }
        });

        legacyFunctions.forEach((fn) => {
            if (fn && fn.name) {
                functionDeclarations.push({
                    name: fn.name,
                    description: fn.description,
                    parameters: cleanParameters(fn.parameters),
                });
            }
        });

        const toolCallNameById = new Map();
        (openaiBody.messages || []).forEach((msg) => {
            if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
                msg.tool_calls.forEach((tc) => {
                    if (tc?.id && tc?.function?.name) {
                        toolCallNameById.set(tc.id, tc.function.name);
                    }
                });
            }
        });

        // 1. 分离出 system 指令
        const systemMessages = openaiBody.messages.filter((msg) => msg.role === "system");
        if (systemMessages.length > 0) {
            const systemContent = systemMessages.map((msg) => msg.content).join("\n");
            systemInstruction = {
                role: "system",
                parts: [{ text: systemContent }],
            };
        }

        // 2. 转换 user / assistant / tool 消息
        const conversationMessages = openaiBody.messages.filter((msg) => msg.role !== "system");
        for (const message of conversationMessages) {
            const googleParts = [];

            if (typeof message.content === "string") {
                googleParts.push({ text: message.content });
            } else if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === "text") {
                        googleParts.push({ text: part.text });
                    } else if (part.type === "image_url" && part.image_url) {
                        const dataUrl = part.image_url.url;
                        const match = dataUrl.match(/^data:(image\/.*?);base64,(.*)$/);
                        if (match) {
                            googleParts.push({
                                inlineData: {
                                    mimeType: match[1],
                                    data: match[2],
                                },
                            });
                        }
                    }
                }
            }

            // OpenAI 工具调用
            if (message.role === "assistant") {
                if (Array.isArray(message.tool_calls)) {
                    message.tool_calls.forEach((toolCall) => {
                        if (toolCall?.type === "function" && toolCall.function?.name) {
                            let parsedArgs = toolCall.function.arguments;
                            if (typeof parsedArgs === "string") {
                                try {
                                    parsedArgs = JSON.parse(parsedArgs);
                                } catch (e) {
                                    parsedArgs = { __raw: parsedArgs };
                                }
                            }
                            googleParts.push({
                                functionCall: {
                                    name: toolCall.function.name,
                                    args: parsedArgs || {},
                                },
                            });
                        }
                    });
                }

                if (message.function_call?.name) {
                    let parsedArgs = message.function_call.arguments;
                    if (typeof parsedArgs === "string") {
                        try {
                            parsedArgs = JSON.parse(parsedArgs);
                        } catch (e) {
                            parsedArgs = { __raw: parsedArgs };
                        }
                    }
                    googleParts.push({
                        functionCall: {
                            name: message.function_call.name,
                            args: parsedArgs || {},
                        },
                    });
                }
            }

            // OpenAI 工具响应
            if (message.role === "tool" || message.role === "function") {
                const toolName = message.name || toolCallNameById.get(message.tool_call_id) || "tool";
                let toolResponse = message.content;
                if (typeof toolResponse === "string") {
                    try {
                        toolResponse = JSON.parse(toolResponse);
                    } catch (e) {
                        toolResponse = { content: toolResponse };
                    }
                }
                googleParts.push({
                    functionResponse: {
                        name: toolName,
                        response: toolResponse ?? {},
                    },
                });
            }

            if (googleParts.length === 0) continue;

            googleContents.push({
                role: message.role === "assistant" ? "model" : "user",
                parts: googleParts,
            });
        }

        // 3. 构建最终的Google请求体
        const googleRequest = {
            contents: googleContents,
            ...(systemInstruction && {
                systemInstruction: { parts: systemInstruction.parts },
            }),
        };

        // 3.5. 注入 Function Declarations (Tools)
        if (functionDeclarations.length > 0) {
            if (!googleRequest.tools) googleRequest.tools = [];
            googleRequest.tools.push({ functionDeclarations });
        }

        // 4. 转换生成参数
        const generationConfig = {
            temperature: openaiBody.temperature,
            topP: openaiBody.top_p,
            topK: openaiBody.top_k,
            maxOutputTokens: openaiBody.max_tokens,
            stopSequences: openaiBody.stop,
        };

        const extraBody = openaiBody.extra_body || {};
        let rawThinkingConfig =
            extraBody.google?.thinking_config ||
            extraBody.google?.thinkingConfig ||
            extraBody.thinkingConfig ||
            extraBody.thinking_config ||
            openaiBody.thinkingConfig ||
            openaiBody.thinking_config;

        let thinkingConfig = null;

        if (rawThinkingConfig) {
            thinkingConfig = {};
            if (rawThinkingConfig.include_thoughts !== undefined) {
                thinkingConfig.includeThoughts = rawThinkingConfig.include_thoughts;
            } else if (rawThinkingConfig.includeThoughts !== undefined) {
                thinkingConfig.includeThoughts = rawThinkingConfig.includeThoughts;
            }
            this.logger.info(`[Adapter] 成功提取并转换推理配置: ${JSON.stringify(thinkingConfig)}`);
        }

        if (!thinkingConfig) {
            const effort = openaiBody.reasoning_effort || extraBody.reasoning_effort;
            if (effort) {
                this.logger.info(`[Adapter] 检测到 OpenAI 标准推理参数 (reasoning_effort: ${effort})，自动转换。`);
                thinkingConfig = { includeThoughts: true };
            }
        }

        if (this.serverSystem.forceThinking && !thinkingConfig) {
            this.logger.info("[Adapter] 强制推理已启用，正在注入 thinkingConfig...");
            thinkingConfig = { includeThoughts: true };
        }

        if (thinkingConfig) {
            generationConfig.thinkingConfig = thinkingConfig;
        }

        googleRequest.generationConfig = generationConfig;

        // 4.5. Tool Choice / Function Call 配置
        const toolChoice = openaiBody.tool_choice !== undefined ? openaiBody.tool_choice : openaiBody.function_call;

        if (toolChoice !== undefined) {
            let functionCallingConfig = null;

            if (toolChoice === "none") {
                functionCallingConfig = { mode: "NONE" };
            } else if (toolChoice === "auto") {
                functionCallingConfig = { mode: "AUTO" };
            } else if (toolChoice === "required") {
                const allowed = functionDeclarations.map((f) => f.name).filter(Boolean);
                functionCallingConfig = {
                    mode: "ANY",
                    ...(allowed.length > 0 ? { allowedFunctionNames: allowed } : {}),
                };
            } else if (typeof toolChoice === "object") {
                const fnName = toolChoice.function?.name || toolChoice.name;
                if (fnName) {
                    functionCallingConfig = {
                        mode: "ANY",
                        allowedFunctionNames: [fnName],
                    };
                }
            }

            if (functionCallingConfig) {
                googleRequest.toolConfig = { functionCallingConfig };
            }
        }

        // 5. 安全设置
        googleRequest.safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ];

        // 强制联网搜索和URL上下文
        if (this.serverSystem.forceWebSearch || this.serverSystem.forceUrlContext) {
            if (!googleRequest.tools) {
                googleRequest.tools = [];
            }
            const toolsToAdd = [];

            if (this.serverSystem.forceWebSearch) {
                const hasSearch = googleRequest.tools.some((t) => t.googleSearch);
                if (!hasSearch) {
                    googleRequest.tools.push({ googleSearch: {} });
                    toolsToAdd.push("googleSearch");
                }
            }

            if (this.serverSystem.forceUrlContext) {
                const hasUrlContext = googleRequest.tools.some((t) => t.urlContext);
                if (!hasUrlContext) {
                    googleRequest.tools.push({ urlContext: {} });
                    toolsToAdd.push("urlContext");
                }
            }

            if (toolsToAdd.length > 0) {
                this.logger.info(`[Adapter] 强制功能已启用，正在注入工具: [${toolsToAdd.join(", ")}]`);
            }
        }

        // 6. 工具过滤
        if (googleRequest.tools && Array.isArray(googleRequest.tools)) {
            const validToolKeys = [
                "functionDeclarations",
                "googleSearchRetrieval",
                "codeExecution",
                "googleSearch",
                "computerUse",
                "urlContext",
                "fileSearch",
                "googleMaps",
            ];

            const originalToolsCount = googleRequest.tools.length;
            googleRequest.tools = googleRequest.tools
                .map((tool) => {
                    const filteredTool = {};
                    for (const key of Object.keys(tool)) {
                        if (validToolKeys.includes(key)) {
                            filteredTool[key] = tool[key];
                        } else {
                            this.logger.warn(`[Adapter] 检测到不支持的工具类型 "${key}"，已自动剔除。`);
                        }
                    }
                    return filteredTool;
                })
                .filter((tool) => Object.keys(tool).length > 0);

            if (googleRequest.tools.length < originalToolsCount) {
                this.logger.info(
                    `[Adapter] 工具过滤完成：原始 ${originalToolsCount} 个，保留 ${googleRequest.tools.length} 个有效工具。`
                );
            }

            if (googleRequest.tools.length === 0) {
                delete googleRequest.tools;
                this.logger.info("[Adapter] 所有工具均被过滤，已移除 tools 字段。");
            }
        }

        this.logger.info("[Adapter] 翻译完成。");
        return googleRequest;
    };

    proto._translateGoogleToOpenAIStream = function (googleChunk, modelName = "gemini-pro", streamState = null) {
        if (!googleChunk || googleChunk.trim() === "") {
            return null;
        }

        if (!streamState) {
            streamState = { toolCallIds: new Map(), toolCallIndex: 0 };
        }

        let jsonString = googleChunk;
        if (jsonString.startsWith("data: ")) {
            jsonString = jsonString.substring(6).trim();
        }

        if (!jsonString || jsonString === "[DONE]") return null;

        let googleResponse;
        try {
            googleResponse = JSON.parse(jsonString);
        } catch (e) {
            this.logger.warn(`[Adapter] 无法解析Google返回的JSON块: ${jsonString}`);
            return null;
        }

        const candidate = googleResponse.candidates?.[0];
        if (!candidate) {
            if (googleResponse.promptFeedback) {
                this.logger.warn(
                    `[Adapter] Google返回了promptFeedback，可能已被拦截: ${JSON.stringify(googleResponse.promptFeedback)}`
                );
                const errorText = `[ProxySystem Error] 请求因为安全原因被拒绝。原因: ${googleResponse.promptFeedback.blockReason}`;
                return `data: ${JSON.stringify({
                    id: `chatcmpl-${this._generateRequestId()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: modelName,
                    choices: [{ index: 0, delta: { content: errorText }, finish_reason: "stop" }],
                })}\n\n`;
            }
            return null;
        }

        const delta = {};
        const toolCalls = [];

        if (candidate.content && Array.isArray(candidate.content.parts)) {
            const imagePart = candidate.content.parts.find((p) => p.inlineData);

            if (imagePart) {
                const image = imagePart.inlineData;
                delta.content = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
                this.logger.info("[Adapter] 从流式响应块中成功解析到图片。");
            } else {
                let contentAccumulator = "";
                let reasoningAccumulator = "";

                for (const part of candidate.content.parts) {
                    if (part.thought === true) {
                        reasoningAccumulator += part.text || "";
                    } else if (part.functionCall) {
                        const fnName = part.functionCall.name;
                        let args = part.functionCall.args;
                        let argsString = "";
                        if (typeof args === "string") {
                            argsString = args;
                        } else {
                            try {
                                argsString = JSON.stringify(args || {});
                            } catch (e) {
                                argsString = "{}";
                            }
                        }

                        let toolCallId = streamState.toolCallIds.get(fnName);
                        if (!toolCallId) {
                            toolCallId = `call_${this._generateRequestId()}`;
                            streamState.toolCallIds.set(fnName, toolCallId);
                        }
                        const toolCallIndex = streamState.toolCallIndex || 0;
                        if (!streamState.toolCallIds.has(`index:${fnName}`)) {
                            streamState.toolCallIds.set(`index:${fnName}`, toolCallIndex);
                            streamState.toolCallIndex = toolCallIndex + 1;
                        }
                        const indexValue = streamState.toolCallIds.get(`index:${fnName}`);
                        toolCalls.push({
                            index: indexValue,
                            id: toolCallId,
                            type: "function",
                            function: {
                                name: fnName,
                                arguments: argsString,
                            },
                        });
                    } else {
                        contentAccumulator += part.text || "";
                    }
                }

                if (reasoningAccumulator) {
                    delta.reasoning_content = reasoningAccumulator;
                }
                if (contentAccumulator) {
                    delta.content = contentAccumulator;
                }
            }
        }

        if (toolCalls.length > 0) {
            delta.tool_calls = toolCalls;
        }

        if (!delta.content && !delta.reasoning_content && !delta.tool_calls && !candidate.finishReason) {
            return null;
        }

        const openaiResponse = {
            id: `chatcmpl-${this._generateRequestId()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [
                {
                    index: 0,
                    delta: delta,
                    finish_reason:
                        candidate.finishReason && delta.tool_calls
                            ? "tool_calls"
                            : candidate.finishReason || null,
                },
            ],
        };

        return `data: ${JSON.stringify(openaiResponse)}\n\n`;
    };
};
