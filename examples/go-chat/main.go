package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Run Phantom · Go OpenAI</title>
  <style>
    :root{color-scheme:light;font-family:"Avenir Next","Segoe UI",ui-sans-serif,system-ui,sans-serif;--canvas:#F8F4EE;--canvas-bright:#FFFBF6;--surface:#FFFBF6;--surface-raised:#F2EADF;--ink:#302730;--muted:#6C616C;--border:#9C8870;--accent:#B83C24;--mark-accent:#C7462D;--accent-strong:#9F301D;--accent-ink:#FFFBF6;--link:#275EA8;--focus:#9F301D}
    *{box-sizing:border-box}
    body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--canvas);color:var(--ink)}
    main{width:min(760px,100%);padding:clamp(24px,4vw,40px);border:1px solid var(--border);border-radius:28px;background:var(--surface);box-shadow:0 24px 60px rgba(48,39,48,.14)}
    .brand{display:flex;gap:16px;align-items:flex-start}
    .brand-mark{flex:0 0 auto;display:block;width:52px;height:52px;color:var(--ink)}
    .eyebrow{margin:2px 0 6px;color:var(--muted);font:600 .74rem/1.3 "SFMono-Regular",Consolas,"Liberation Mono",monospace;letter-spacing:.16em;text-transform:uppercase}
    h1{margin:0;font-family:"Avenir Next Condensed","Arial Narrow","Segoe UI Variable Display",sans-serif;letter-spacing:-.04em;font-size:clamp(2rem,5vw,3rem);line-height:1.03}
    .tagline{margin:16px 0 8px;color:var(--accent);font-size:1rem;font-weight:700}
    p{margin:0;color:var(--muted);line-height:1.6}
    form{display:grid;gap:14px;margin-top:28px}
    label{font-size:.92rem;font-weight:700;color:var(--ink)}
    textarea,button{border-radius:18px;border:1px solid var(--border);padding:14px 16px;font:inherit}
    textarea{min-height:136px;resize:vertical;background:var(--surface-raised);color:var(--ink);box-shadow:inset 0 1px 0 rgba(255,255,255,.7)}
    textarea::placeholder{color:var(--muted)}
    textarea:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
    .actions{display:grid;gap:12px;align-items:center}
    .hint{font-size:.95rem}
    button{width:auto;min-width:200px;justify-self:start;background:var(--accent);color:var(--accent-ink);font-weight:750;cursor:pointer;box-shadow:0 12px 24px rgba(184,60,36,.2);transition:transform 160ms ease,background-color 160ms ease,box-shadow 160ms ease}
    button:hover:not(:disabled){transform:translateY(-1px);background:var(--accent-strong);box-shadow:0 16px 28px rgba(159,48,29,.24)}
    button:disabled{opacity:.6;cursor:wait;transform:none;box-shadow:none}
    #result{min-width:0;min-height:52px;margin-top:22px;padding-top:18px;border-top:1px solid var(--border);color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
    a{color:var(--link);font-weight:700;text-underline-offset:.16em}
    @media (min-width:640px){.actions{grid-template-columns:1fr auto;gap:16px;align-items:end}}
    @media (max-width:640px){body{padding:16px}main{padding:22px;border-radius:22px}.brand{gap:12px}.brand-mark{width:46px;height:46px}button{width:100%;min-width:0}}
    @media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;scroll-behavior:auto!important;transition:none!important}}
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand">
        <svg class="brand-mark" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
          <rect width="64" height="64" rx="16" fill="var(--surface-raised)"></rect>
          <path d="M12 26V12H26M38 52H52V38" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"></path>
          <path d="M12 42C20 42 20 22 30 22C40 22 39 42 52 42" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"></path>
          <circle cx="30" cy="22" r="5" fill="var(--mark-accent)"></circle>
        </svg>
        <div>
          <p class="eyebrow">Run Phantom example</p>
          <h1>Run Phantom · Go OpenAI</h1>
        </div>
      </div>
      <p class="tagline">See the run. Find the reason.</p>
      <p>Provider-direct OpenAI with vendor-neutral OTLP/HTTP export.</p>
    </header>
    <form id="chat">
      <label for="message">Prompt</label>
      <textarea id="message" name="message" required placeholder="Ask the model something."></textarea>
      <div class="actions">
        <p class="hint">This sends one provider-direct request and exports the trace to your local Run Phantom daemon.</p>
        <button>Send and trace</button>
      </div>
    </form>
    <p id="result" role="status" aria-live="polite"></p>
  </main>
  <script>
    const f=document.querySelector('#chat'),r=document.querySelector('#result');
    f.addEventListener('submit',async e=>{
      e.preventDefault();
      const b=f.querySelector('button');
      b.disabled=true;
      r.textContent='Running...';
      try{
        const x=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:new FormData(f).get('message')})}),j=await x.json();
        if(!x.ok)throw Error(j.error||'Request failed');
        r.replaceChildren(document.createTextNode(j.text+'\n'),Object.assign(document.createElement('a'),{href:j.runUrl,textContent:'Open in Run Phantom'}));
      }catch(e){
        r.textContent=e.message;
      }finally{
        b.disabled=false;
      }
    })
  </script>
</body>
</html>`

var client = &http.Client{Timeout: 60 * time.Second}

type chatInput struct {
	Message string `json:"message"`
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openAIResponse struct {
	Model   string `json:"model"`
	Choices []struct {
		Message message `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

func id(size int) string {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value)
}

func attribute(key string, value any) map[string]any {
	encoded := map[string]any{}
	switch typed := value.(type) {
	case bool:
		encoded["boolValue"] = typed
	case int:
		encoded["intValue"] = strconv.Itoa(typed)
	case int64:
		encoded["intValue"] = strconv.FormatInt(typed, 10)
	default:
		encoded["stringValue"] = fmt.Sprint(typed)
	}
	return map[string]any{"key": key, "value": encoded}
}

func attributes(values map[string]any) []map[string]any {
	result := make([]map[string]any, 0, len(values))
	for key, value := range values {
		result = append(result, attribute(key, value))
	}
	return result
}

func otlpEndpoint() string {
	if value := os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"); value != "" {
		return value
	}
	return "http://localhost:5947/v1/traces"
}

func runURL(traceID string) string {
	parsed, err := url.Parse(otlpEndpoint())
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "http://localhost:5947/runs/" + traceID
	}
	return parsed.Scheme + "://" + parsed.Host + "/runs/" + traceID
}

func callOpenAI(input []message, model string) (openAIResponse, error) {
	body, _ := json.Marshal(map[string]any{"model": model, "messages": input})
	request, err := http.NewRequest(http.MethodPost, "https://api.openai.com/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return openAIResponse{}, err
	}
	request.Header.Set("authorization", "Bearer "+os.Getenv("OPENAI_API_KEY"))
	request.Header.Set("content-type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return openAIResponse{}, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return openAIResponse{}, err
	}
	if response.StatusCode >= 400 {
		return openAIResponse{}, fmt.Errorf("OpenAI request failed (%d): %s", response.StatusCode, strings.TrimSpace(string(data)))
	}
	var result openAIResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return openAIResponse{}, err
	}
	if len(result.Choices) == 0 {
		return openAIResponse{}, errors.New("OpenAI response contained no choices")
	}
	return result, nil
}

func exportTrace(spans []map[string]any) error {
	body, _ := json.Marshal(map[string]any{
		"resourceSpans": []any{map[string]any{
			"resource": map[string]any{"attributes": []any{attribute("service.name", "runphantom-examples")}},
			"scopeSpans": []any{map[string]any{
				"scope": map[string]any{"name": "runphantom.examples", "version": "1.0.0"},
				"spans": spans,
			}},
		}},
	})
	request, err := http.NewRequest(http.MethodPost, otlpEndpoint(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return fmt.Errorf("OTLP export failed (%d)", response.StatusCode)
	}
	return nil
}

func span(traceID, spanID, parentID, name string, started, ended int64, attrs map[string]any, errorMessage string) map[string]any {
	status := map[string]any{"code": 1}
	if errorMessage != "" {
		status = map[string]any{"code": 2, "message": errorMessage}
	}
	result := map[string]any{
		"traceId": traceID, "spanId": spanID, "name": name,
		"startTimeUnixNano": strconv.FormatInt(started, 10),
		"endTimeUnixNano":   strconv.FormatInt(ended, 10),
		"attributes":        attributes(attrs), "status": status,
	}
	if parentID != "" {
		result["parentSpanId"] = parentID
	}
	return result
}

func chat(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var input chatInput
	if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, 64*1024)).Decode(&input); err != nil || strings.TrimSpace(input.Message) == "" {
		writeJSON(response, http.StatusBadRequest, map[string]any{"error": "message is required"})
		return
	}
	if os.Getenv("OPENAI_API_KEY") == "" {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"error": "OPENAI_API_KEY is not configured"})
		return
	}

	model := os.Getenv("OPENAI_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	messages := []message{{Role: "user", Content: strings.TrimSpace(input.Message)}}
	traceID, rootID, llmID, eventID := id(16), id(8), id(8), id(16)
	rootStarted, llmStarted := time.Now().UnixNano(), time.Now().UnixNano()
	result, err := callOpenAI(messages, model)
	if err != nil {
		ended := time.Now().UnixNano()
		inputJSON, _ := json.Marshal(messages)
		outputJSON, _ := json.Marshal(map[string]string{"error": err.Error()})
		failedSpans := []map[string]any{
			span(traceID, rootID, "", "go-openai-chat", rootStarted, ended, map[string]any{
				"runphantom.span.kind": "agent_root", "runphantom.event.id": eventID,
				"runphantom.event.name": "go-openai-chat", "runphantom.input": string(inputJSON),
				"runphantom.output": string(outputJSON),
			}, err.Error()),
			span(traceID, llmID, rootID, "openai.chat.completions", llmStarted, ended, map[string]any{
				"runphantom.span.kind": "llm_call", "gen_ai.operation.name": "chat",
				"gen_ai.provider.name": "openai", "gen_ai.request.model": model,
				"gen_ai.input.messages": string(inputJSON), "gen_ai.output.messages": string(outputJSON),
			}, err.Error()),
		}
		_ = exportTrace(failedSpans)
		writeJSON(response, http.StatusBadGateway, map[string]any{"error": err.Error(), "runUrl": runURL(traceID)})
		return
	}
	ended := time.Now().UnixNano()
	inputJSON, _ := json.Marshal(messages)
	outputJSON, _ := json.Marshal([]message{result.Choices[0].Message})
	spans := []map[string]any{
		span(traceID, rootID, "", "go-openai-chat", rootStarted, ended, map[string]any{
			"runphantom.span.kind": "agent_root", "runphantom.event.id": eventID,
			"runphantom.event.name": "go-openai-chat", "runphantom.input": string(inputJSON),
			"runphantom.output": string(outputJSON),
		}, ""),
		span(traceID, llmID, rootID, "openai.chat.completions", llmStarted, ended, map[string]any{
			"runphantom.span.kind": "llm_call", "gen_ai.operation.name": "chat",
			"gen_ai.provider.name": "openai", "gen_ai.request.model": result.Model,
			"gen_ai.input.messages": string(inputJSON), "gen_ai.output.messages": string(outputJSON),
			"gen_ai.usage.input_tokens":  result.Usage.PromptTokens,
			"gen_ai.usage.output_tokens": result.Usage.CompletionTokens,
		}, ""),
	}
	if err := exportTrace(spans); err != nil {
		writeJSON(response, http.StatusBadGateway, map[string]any{"error": err.Error(), "runUrl": runURL(traceID)})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"text": result.Choices[0].Message.Content, "runUrl": runURL(traceID)})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("content-type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3019"
	}
	http.HandleFunc("/", func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/" {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = io.WriteString(response, page)
	})
	http.HandleFunc("/api/chat", chat)
	log.Printf("Run Phantom Go example: http://localhost:%s", port)
	log.Fatal(http.ListenAndServe("127.0.0.1:"+port, nil))
}
