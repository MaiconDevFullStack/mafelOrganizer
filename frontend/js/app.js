/* ════════════════════════════════════════════════════════════════
   app.js — MafelOrganizer Chat
   AngularJS 1.x + $http para integração com backend Node.js
════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Módulo principal ──────────────────────────────────────────
  angular.module('mafelApp', ['ngSanitize'])

  // ── Constante de configuração ─────────────────────────────────
  .constant('CONFIG', {
    API_BASE: '/api',
    // Detecta o tenant pela URL:
    //   /chat/<agentSlug>  → busca por agent_slug (URL personalizada do agente)
    //   ?tenant=<slug>     → busca por tenant slug (compat. legada)
    getTenantInfo: function () {
      var pathMatch = window.location.pathname.match(/^\/chat\/([^/]+)/);
      if (pathMatch) return { slug: pathMatch[1], byAgent: true };
      var params = new URLSearchParams(window.location.search);
      return { slug: params.get('tenant') || 'demo', byAgent: false };
    },
    // Mantido por compatibilidade com código legado
    getTenantSlug: function () {
      var params = new URLSearchParams(window.location.search);
      return params.get('tenant') || 'demo';
    },
  })

  // ── Serviço de API ────────────────────────────────────────────
  .service('ApiService', ['$http', 'CONFIG', function ($http, CONFIG) {
    var BASE = CONFIG.API_BASE;

    this.getTenant = function (info) {
      // Aceita string (compat. legada) ou objeto { slug, byAgent }
      if (typeof info === 'string') return $http.get(BASE + '/tenants/' + info);
      if (info.byAgent) return $http.get(BASE + '/tenants/agent/' + info.slug);
      return $http.get(BASE + '/tenants/' + info.slug);
    };

    this.startConversation = function (tenantId, clientName, clientEmail) {
      return $http.post(BASE + '/conversations', {
        tenant_id: tenantId,
        client_name: clientName || 'Visitante',
        client_email: clientEmail || null,
        channel: 'web',
      });
    };

    this.sendMessage = function (conversationId, text) {
      return $http.post(BASE + '/conversations/' + conversationId + '/messages', {
        text: text,
      });
    };

    this.getPaymentSchedules = function (tenantId) {
      return $http.get(BASE + '/payments/schedules?tenant_id=' + tenantId);
    };

    this.createPaymentSchedule = function (data) {
      return $http.post(BASE + '/payments/schedules', data);
    };

    this.executePayment = function (scheduleId) {
      return $http.post(BASE + '/payments/schedules/' + scheduleId + '/execute', {});
    };

    // ── Agendamento via chat ─────────────────────────────────
    this.schedulingStep = function (tenantId, conversationId, step, text) {
      return $http.post(BASE + '/scheduling/step', {
        tenant_id:       tenantId,
        conversation_id: conversationId || null,
        step:            step,
        payload:         { text: text || '' },
      });
    };
  }])

  // ── Controller principal ──────────────────────────────────────
  .controller('AppController', [
    '$scope', '$timeout', '$sce', 'ApiService', 'CONFIG',
    function ($scope, $timeout, $sce, ApiService, CONFIG) {
      var vm = this;

      // Estado ────────────────────────────────────────────────
      vm.loading         = true;
      vm.tenant          = {};
      vm.messages        = [];
      vm.inputText       = '';
      vm.isTyping        = false;
      vm.isSending       = false;
      vm.minimized       = false;
      vm.conversationId  = null;
      vm.backgroundStyle = {};

      // ── Estado do fluxo de agendamento ───────────────────────
      // null = fora do fluxo; string = passo atual
      vm.bookingStep    = null;
      vm.bookingSession = {};

      // ── Inicialização ────────────────────────────────────────
      vm.init = function () {
        var info = CONFIG.getTenantInfo();

        ApiService.getTenant(info)
          .then(function (res) {
            vm.tenant = res.data;
            vm.applyTenantTheme(vm.tenant);

            return ApiService.startConversation(
              vm.tenant.id,
              null,
              null
            );
          })
          .then(function (res) {
            vm.conversationId = res.data.id;
            _resetInactivityTimer(); // começa a contar inatividade
            // Mostra a saudação dinâmica gerada pelo Groq no backend
            if (res.data.welcomeMessage) {
              vm.messages.push({
                author:     'agent',
                text:       res.data.welcomeMessage,
                created_at: new Date(),
              });
            }
          })
          .catch(function (err) {
            console.warn('Tenant não encontrado, usando padrão.', err);
            vm.tenant = {
              agent_name:      'Assistente',
              primary_color:   '#2563eb',
              welcome_message: 'Olá! Como posso ajudar?',
            };
          })
          .finally(function () {
            vm.loading = false;
            $timeout(function () {
              focusChatInput();
            }, 300);
          });
      };

      // ── Aplicar tema do tenant ───────────────────────────────
      vm.applyTenantTheme = function (tenant) {
        if (tenant.background_url) {
          vm.backgroundStyle = {
            'background-image': 'url("' + tenant.background_url + '")',
          };
        } else if (tenant.primary_color) {
          // Gradient suave baseado na cor principal
          var hex  = tenant.primary_color || '#2563eb';
          vm.backgroundStyle = {
            'background': 'linear-gradient(135deg, ' + hex + '22 0%, #f0f4f8 60%)',
          };
        }

        // Atualiza CSS var dinamicamente
        if (tenant.primary_color) {
          document.documentElement.style.setProperty('--primary', tenant.primary_color);
        }
      };

      // ── Enviar mensagem ──────────────────────────────────────
      vm.sendMessage = function () {
        var text = (vm.inputText || '').trim();
        if (!text || vm.isSending) return;

        _resetInactivityTimer(); // reinicia contagem de inatividade

        vm.isSending = true;
        vm.inputText = '';

        // Adiciona mensagem do cliente imediatamente
        vm.messages.push({
          author:     'client',
          text:       text,
          created_at: new Date(),
        });

        $timeout(scrollToBottom, 50);

        // Mostra indicador de digitação após pequeno delay
        // Guarda a referência para cancelar se a resposta chegar antes
        var typingTimer = $timeout(function () {
          vm.isTyping = true;
          scrollToBottom();
        }, 200);

        function stopTyping() {
          $timeout.cancel(typingTimer);
          vm.isTyping = false;
        }

        var fn;
        if (vm.conversationId) {
          fn = ApiService.sendMessage(vm.conversationId, text);
        } else {
          // Sem conversa ainda: resposta stub local
          fn = {
            then: function (cb) {
              cb({ data: { agentMessage: { text: 'Olá! Parece que não consegui conectar ao servidor. Tente recarregar a página.', created_at: new Date(), author: 'agent' } } });
              return fn;
            },
            catch: function () { return fn; },
            finally: function (cb) { cb(); return fn; },
          };
        }

        fn
          .then(function (res) {
            stopTyping();
            var agentMsg = res.data.agentMessage;
            if (agentMsg) {
              agentMsg.created_at = new Date();
              vm.messages.push(agentMsg);
            }
            $timeout(scrollToBottom, 50);
          })
          .catch(function () {
            stopTyping();
            vm.messages.push({
              author:     'agent',
              text:       'Desculpe, ocorreu um erro. Tente novamente.',
              created_at: new Date(),
            });
          })
          .finally(function () {
            vm.isSending = false;
          });
      };

      // ── Iniciar fluxo de agendamento ─────────────────────────
      vm.startBooking = function () {
        if (vm.isSending || vm.bookingStep) return;

        // Bolha de clique do cliente
        vm.messages.push({
          author: 'client', text: '📋 Contratar serviço', created_at: new Date(),
        });
        $timeout(scrollToBottom, 50);

        vm.bookingStep    = 'set_name';   // próximo passo aguardado
        vm.bookingSession = {};
        vm.isSending      = true;

        // Exibe indicador apenas após o delay para evitar flash instantâneo
        var bookingTypingTimer = $timeout(function () {
          vm.isTyping = true;
          scrollToBottom();
        }, 200);

        ApiService.schedulingStep(
          vm.tenant.id, vm.conversationId, 'init', ''
        ).then(function (res) {
          $timeout.cancel(bookingTypingTimer);
          vm.isTyping  = false;
          vm.isSending = false;
          var data = res.data;
          vm.messages.push({ author: 'agent', text: data.reply, created_at: new Date() });
          vm.bookingStep = data.nextStep;
          if (data.nextStep === 'done') vm.bookingStep = null;
          $timeout(scrollToBottom, 50);
        }).catch(function () {
          $timeout.cancel(bookingTypingTimer);
          vm.isTyping  = false;
          vm.isSending = false;
          vm.messages.push({ author: 'agent', text: 'Não foi possível iniciar o agendamento. Tente novamente.', created_at: new Date() });
          vm.bookingStep = null;
        });
      };

      // ── Enviar passo do agendamento ──────────────────────────
      vm.sendBookingStep = function () {
        var text = (vm.inputText || '').trim();
        if (!text || vm.isSending) return;

        _resetInactivityTimer();

        vm.isSending = true;
        var currentStep = vm.bookingStep;
        vm.inputText = '';

        vm.messages.push({ author: 'client', text: text, created_at: new Date() });
        $timeout(scrollToBottom, 50);

        var stepTypingTimer = $timeout(function () {
          vm.isTyping = true;
          scrollToBottom();
        }, 200);

        ApiService.schedulingStep(
          vm.tenant.id, vm.conversationId, currentStep, text
        ).then(function (res) {
          $timeout.cancel(stepTypingTimer);
          vm.isTyping  = false;
          vm.isSending = false;
          var data = res.data;
          vm.messages.push({ author: 'agent', text: data.reply, created_at: new Date() });
          vm.bookingStep = (data.nextStep === 'done') ? null : data.nextStep;
          $timeout(scrollToBottom, 50);
        }).catch(function () {
          $timeout.cancel(stepTypingTimer);
          vm.isTyping  = false;
          vm.isSending = false;
          vm.messages.push({ author: 'agent', text: 'Erro ao processar. Tente novamente.', created_at: new Date() });
        });
      };

      // ── Cancelar agendamento em curso ────────────────────────
      vm.cancelBooking = function () {
        vm.bookingStep    = null;
        vm.bookingSession = {};
        vm.messages.push({
          author: 'agent',
          text: 'Agendamento cancelado. Como posso ajudar?',
          created_at: new Date(),
        });
        $timeout(scrollToBottom, 50);
      };

      // ── Enter para enviar (Shift+Enter para quebra de linha) ─
      vm.handleKeydown = function ($event) {
        if ($event.key === 'Enter' && !$event.shiftKey) {
          $event.preventDefault();
          if (vm.bookingStep) {
            vm.sendBookingStep();
          } else {
            vm.sendMessage();
          }
        }
      };

      // ── Minimizar/expandir ───────────────────────────────────
      vm.toggleMinimize = function () {
        vm.minimized = !vm.minimized;
      };

      // ── Sanitiza HTML no texto ───────────────────────────────
      vm.parseText = function (text) {
        if (!text) return '';
        var safe = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\n/g, '<br>');
        return $sce.trustAsHtml(safe);
      };

      // ── Helpers ──────────────────────────────────────────────
      function scrollToBottom() {
        var el = document.getElementById('messagesArea');
        if (el) el.scrollTop = el.scrollHeight;
      }

      function focusChatInput() {
        var el = document.getElementById('chatInput');
        if (el) el.focus();
      }

      // ── Encerrar sessão do cliente ───────────────────────────
      // Usa sendBeacon para garantir envio mesmo quando a aba fecha.
      var _inactivityTimer = null;
      var INACTIVITY_MS    = 20 * 60 * 1000; // 20 min sem mensagem

      function _closeSession() {
        if (!vm.conversationId) return;
        var url = '/api/conversations/' + vm.conversationId + '/close';
        if (navigator.sendBeacon) {
          navigator.sendBeacon(url);
        } else {
          // Fallback síncrono para browsers antigos
          var xhr = new XMLHttpRequest();
          xhr.open('POST', url, false);
          xhr.send();
        }
        vm.conversationId = null; // evita duplo envio
      }

      function _resetInactivityTimer() {
        if (_inactivityTimer) clearTimeout(_inactivityTimer);
        _inactivityTimer = setTimeout(function () {
          // Avisa o cliente e encerra
          $scope.$apply(function () {
            vm.messages.push({
              author: 'agent',
              text: 'Sua sessão foi encerrada por inatividade. Recarregue a página para continuar.',
              created_at: new Date(),
            });
            scrollToBottom();
          });
          _closeSession();
        }, INACTIVITY_MS);
      }

      // Fecha ao sair/recarregar a página
      window.addEventListener('beforeunload', _closeSession);

      // Fecha quando a aba entra em segundo plano por mais de 5 min
      var _hiddenTimer = null;
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          _hiddenTimer = setTimeout(_closeSession, 5 * 60 * 1000);
        } else {
          if (_hiddenTimer) { clearTimeout(_hiddenTimer); _hiddenTimer = null; }
        }
      });

      // Auto-resize do textarea
      $scope.$watch(function () { return vm.inputText; }, function () {
        $timeout(function () {
          var el = document.getElementById('chatInput');
          if (!el) return;
          el.style.height = 'auto';
          el.style.height = Math.min(el.scrollHeight, 120) + 'px';
        });
      });

      // Inicializar ao carregar
      vm.init();
    },
  ]);

})();
