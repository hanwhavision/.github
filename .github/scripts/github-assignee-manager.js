/**
 * GitHub 이슈 어사이니 관리 모듈
 * 다양한 상황에서 GitHub 이슈에 어사이니를 할당하는 통합 로직을 제공합니다.
 */

/**
 * GitHub 사용자 정보를 검증하고 node_id를 반환하는 함수
 * @param {Object} github - GitHub API 클라이언트
 * @param {string} username - GitHub 사용자명
 * @returns {Promise<Object|null>} 사용자 정보 객체 또는 null
 */
async function validateGitHubUser(github, username) {
  try {
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      return null;
    }

    const cleanUsername = username.trim();
    console.log(`🔍 Validating GitHub user: "${cleanUsername}"`);
    
    const userResponse = await github.rest.users.getByUsername({
      username: cleanUsername
    });
    
    console.log(`✅ Found user "${cleanUsername}":`, {
      login: userResponse.data.login,
      id: userResponse.data.id,
      node_id: userResponse.data.node_id,
      type: userResponse.data.type
    });
    
    return {
      login: userResponse.data.login,
      id: userResponse.data.id,
      node_id: userResponse.data.node_id,
      type: userResponse.data.type
    };
  } catch (error) {
    console.log(`❌ Failed to validate GitHub user "${username}":`, {
      message: error.message,
      status: error.status
    });
    
    if (error.status === 404) {
      console.log(`❌ GitHub user "${username}" does not exist`);
    } else if (error.status === 403) {
      console.log(`❌ Access forbidden for user "${username}" - may be rate limited or private`);
    }
    
    return null;
  }
}

/**
 * Copilot 봇을 찾고 검증하는 함수
 * @param {Object} github - GitHub API 클라이언트
 * @param {Object} context - GitHub Actions context
 * @returns {Promise<Object|null>} Copilot 정보 객체 또는 null
 */
async function findCopilotBot(github, context) {
  console.log(`🤖 Searching for Copilot bot...`);
  
  try {
    // Step 1: GraphQL로 repository의 suggested actors 확인
    const suggestedActorsQuery = `
      query {
        repository(owner: "${context.repo.owner}", name: "${context.repo.repo}") {
          suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
            nodes {
              login
              __typename
              ... on Bot {
                id
              }
              ... on User {
                id
              }
            }
          }
          id
        }
      }
    `;
    
    const result = await github.graphql(suggestedActorsQuery);
    const suggestedActors = result.repository.suggestedActors.nodes;
    
    console.log(`📋 Found ${suggestedActors.length} suggested actors:`);
    suggestedActors.forEach(actor => {
      console.log(`  - ${actor.login} (${actor.__typename})`);
    });
    
    // copilot-swe-agent를 우선 검색
    let copilotActor = suggestedActors.find(actor => actor.login === 'copilot-swe-agent');
    
    if (copilotActor) {
      console.log(`✅ Found Copilot coding agent: ${copilotActor.login} (ID: ${copilotActor.id})`);
      return {
        login: copilotActor.login,
        node_id: copilotActor.id,
        type: 'graphql_suggested'
      };
    }
    
    // 대안 Copilot 봇들 검색
    const altCopilot = suggestedActors.find(actor => 
      actor.login.includes('copilot') || 
      actor.login === 'github-copilot[bot]' ||
      actor.login === 'copilot' ||
      (actor.__typename === 'Bot' && actor.login.toLowerCase().includes('copilot'))
    );
    
    if (altCopilot) {
      console.log(`✅ Found alternative Copilot bot: ${altCopilot.login} (ID: ${altCopilot.id})`);
      return {
        login: altCopilot.login,
        node_id: altCopilot.id,
        type: 'graphql_suggested'
      };
    }
    
  } catch (error) {
    console.log(`⚠️ Failed to check for Copilot via GraphQL: ${error.message}`);
  }
  
  // Step 2: REST API로 copilot-swe-agent 직접 검색
  try {
    const copilotUsernames = ['copilot-swe-agent', 'copilot', 'github-copilot[bot]'];
    
    for (const username of copilotUsernames) {
      const userInfo = await validateGitHubUser(github, username);
      if (userInfo) {
        console.log(`✅ Found Copilot bot via REST API: ${userInfo.login}`);
        return {
          login: userInfo.login,
          node_id: userInfo.node_id,
          type: 'rest_api'
        };
      }
    }
    
  } catch (error) {
    console.log(`⚠️ Failed to find Copilot via REST API: ${error.message}`);
  }
  
  console.log(`❌ No Copilot bot found`);
  return null;
}

/**
 * 어사이니 할당을 위한 준비 함수
 * @param {Object} github - GitHub API 클라이언트
 * @param {Object} context - GitHub Actions context
 * @param {Array<string>} reviewers - 리뷰어 사용자명 배열
 * @param {boolean} includeCopilot - Copilot 포함 여부 (기본값: true)
 * @returns {Promise<Object>} 준비된 어사이니 정보
 */
async function prepareAssignees(github, context, reviewers = [], includeCopilot = true) {
  console.log(`🎯 Preparing assignees...`);
  console.log(`  - Include Copilot: ${includeCopilot}`);
  console.log(`  - Reviewers count: ${reviewers.length}`);
  console.log(`  - Reviewers: [${reviewers.join(', ')}]`);
  
  const result = {
    copilot: null,
    validReviewers: [],
    invalidReviewers: [],
    assigneeNodeIds: [],
    assigneeUsernames: [],
    repositoryId: null
  };
  
  // Repository ID 가져오기 (GraphQL용)
  try {
    const repoQuery = `
      query {
        repository(owner: "${context.repo.owner}", name: "${context.repo.repo}") {
          id
        }
      }
    `;
    const repoResult = await github.graphql(repoQuery);
    result.repositoryId = repoResult.repository.id;
    console.log(`📋 Repository ID: ${result.repositoryId}`);
  } catch (error) {
    console.log(`⚠️ Failed to get repository ID: ${error.message}`);
  }
  
  // Copilot 봇 찾기
  if (includeCopilot) {
    result.copilot = await findCopilotBot(github, context);
    
    if (result.copilot) {
      result.assigneeNodeIds.push(result.copilot.node_id);
      result.assigneeUsernames.push(result.copilot.login);
      console.log(`✅ Added Copilot to assignees: ${result.copilot.login}`);
    }
  }
  
  // 리뷰어들 검증
  for (let i = 0; i < reviewers.length; i++) {
    const reviewer = reviewers[i];
    const userInfo = await validateGitHubUser(github, reviewer);
    
    if (userInfo) {
      result.validReviewers.push(userInfo);
      result.assigneeNodeIds.push(userInfo.node_id);
      result.assigneeUsernames.push(userInfo.login);
      console.log(`✅ Added reviewer to assignees: ${userInfo.login}`);
    } else {
      result.invalidReviewers.push(reviewer);
      console.log(`❌ Invalid reviewer: ${reviewer}`);
    }
    
    // Rate limiting 방지
    if (i < reviewers.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  console.log(`📊 Assignee preparation summary:`);
  console.log(`  - Copilot found: ${result.copilot ? result.copilot.login : 'No'}`);
  console.log(`  - Valid reviewers: ${result.validReviewers.length} [${result.validReviewers.map(r => r.login).join(', ')}]`);
  console.log(`  - Invalid reviewers: ${result.invalidReviewers.length} [${result.invalidReviewers.join(', ')}]`);
  console.log(`  - Total assignees prepared: ${result.assigneeNodeIds.length}`);
  
  return result;
}

/**
 * GraphQL을 사용하여 이슈 생성 및 어사이니 할당
 * @param {Object} github - GitHub API 클라이언트
 * @param {Object} context - GitHub Actions context
 * @param {string} title - 이슈 제목
 * @param {string} body - 이슈 본문
 * @param {Array<string>} labels - 라벨 배열
 * @param {Object} assigneeInfo - prepareAssignees()에서 반환된 정보
 * @returns {Promise<Object|null>} 생성된 이슈 정보 또는 null
 */
async function createIssueWithGraphQL(github, context, title, body, labels, assigneeInfo) {
  console.log(`🚀 Attempting GraphQL issue creation...`);
  
  if (!assigneeInfo.repositoryId || assigneeInfo.assigneeNodeIds.length === 0) {
    console.log(`ℹ️ Skipping GraphQL creation - missing requirements`);
    console.log(`  - Repository ID: ${assigneeInfo.repositoryId ? 'present' : 'missing'}`);
    console.log(`  - Assignee node IDs: ${assigneeInfo.assigneeNodeIds.length}`);
    return null;
  }
  
  try {
    // 라벨 ID 가져오기
    const getLabelsQuery = `
      query {
        repository(owner: "${context.repo.owner}", name: "${context.repo.repo}") {
          labels(first: 100) {
            nodes {
              id
              name
            }
          }
        }
      }
    `;
    
    const labelsResult = await github.graphql(getLabelsQuery);
    const existingLabels = labelsResult.repository.labels.nodes;
    
    const labelIds = [];
    const missingLabels = [];
    
    for (const labelName of labels) {
      const existingLabel = existingLabels.find(label => label.name === labelName);
      if (existingLabel) {
        labelIds.push(existingLabel.id);
        console.log(`✅ Found label ID for "${labelName}": ${existingLabel.id}`);
      } else {
        missingLabels.push(labelName);
        console.log(`⚠️ Label "${labelName}" does not exist - will be created later`);
      }
    }
    
    // 이슈 생성 mutation
    const createIssueMutation = `
      mutation {
        createIssue(input: {
          repositoryId: "${assigneeInfo.repositoryId}",
          title: ${JSON.stringify(title)},
          body: ${JSON.stringify(body)},
          assigneeIds: ${JSON.stringify(assigneeInfo.assigneeNodeIds)}${labelIds.length > 0 ? `,
          labelIds: ${JSON.stringify(labelIds)}` : ''}
        }) {
          issue {
            id
            number
            title
            assignees(first: 10) {
              nodes {
                login
                id
              }
            }
            labels(first: 10) {
              nodes {
                name
              }
            }
          }
        }
      }
    `;
    
    const createResult = await github.graphql(createIssueMutation);
    const issue = createResult.createIssue.issue;
    
    console.log(`✅ Created issue #${issue.number} via GraphQL with ${issue.assignees.nodes.length} assignees:`);
    issue.assignees.nodes.forEach(assignee => {
      console.log(`   - ${assignee.login}`);
    });
    
    // 누락된 라벨 추가 (REST API 사용)
    if (missingLabels.length > 0) {
      console.log(`➕ Adding ${missingLabels.length} missing labels via REST API`);
      await github.rest.issues.addLabels({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issue.number,
        labels: missingLabels
      });
    }
    
    return {
      number: issue.number,
      id: issue.id,
      assignees: issue.assignees.nodes,
      method: 'graphql'
    };
    
  } catch (error) {
    console.log(`❌ Failed to create issue with GraphQL:`, {
      message: error.message,
      errors: error.errors
    });
    return null;
  }
}

/**
 * REST API를 사용하여 이슈에 어사이니 할당
 * @param {Object} github - GitHub API 클라이언트
 * @param {Object} context - GitHub Actions context
 * @param {number} issueNumber - 이슈 번호
 * @param {Object} assigneeInfo - prepareAssignees()에서 반환된 정보
 * @returns {Promise<Array>} 최종 할당된 어사이니 배열
 */
async function assignUsersToIssue(github, context, issueNumber, assigneeInfo) {
  console.log(`🎯 Attempting to assign users to issue #${issueNumber}...`);
  
  if (assigneeInfo.assigneeUsernames.length === 0) {
    console.log(`ℹ️ No assignees to add`);
    return [];
  }
  
  try {
    console.log(`🎯 Attempting to assign ${assigneeInfo.assigneeUsernames.length} users: ${assigneeInfo.assigneeUsernames.join(', ')}`);
    
    const assignResponse = await github.rest.issues.addAssignees({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber,
      assignees: assigneeInfo.assigneeUsernames
    });
    
    console.log(`✅ Successfully assigned users to issue #${issueNumber}:`);
    assignResponse.data.assignees.forEach(assignee => {
      console.log(`   - ${assignee.login}`);
    });
    
    return assignResponse.data.assignees;
    
  } catch (error) {
    console.log(`❌ Failed to assign users via REST API:`, {
      message: error.message,
      status: error.status
    });
    return [];
  }
}

/**
 * GraphQL을 사용하여 이슈에 어사이니 추가 할당
 * @param {Object} github - GitHub API 클라이언트
 * @param {Object} context - GitHub Actions context
 * @param {number} issueNumber - 이슈 번호
 * @param {Object} assigneeInfo - prepareAssignees()에서 반환된 정보
 * @param {Array} currentAssignees - 현재 할당된 어사이니들
 * @returns {Promise<Array>} 최종 할당된 어사이니 배열
 */
async function addAssigneesWithGraphQL(github, context, issueNumber, assigneeInfo, currentAssignees = []) {
  console.log(`🔄 Attempting GraphQL assignment as additional method...`);
  
  try {
    // 이슈 ID 가져오기
    const issueIdQuery = `
      query {
        repository(owner: "${context.repo.owner}", name: "${context.repo.repo}") {
          issue(number: ${issueNumber}) {
            id
            assignees(first: 10) {
              nodes {
                login
              }
            }
          }
        }
      }
    `;
    
    const issueResult = await github.graphql(issueIdQuery);
    const issueId = issueResult.repository.issue.id;
    const currentAssigneeLogins = issueResult.repository.issue.assignees.nodes.map(a => a.login);
    
    console.log(`📋 Current assignees: [${currentAssigneeLogins.join(', ')}]`);
    
    // 새로 추가할 어사이니 필터링
    const newAssigneeIds = [];
    const newAssigneeLogins = [];
    
    for (let i = 0; i < assigneeInfo.assigneeUsernames.length; i++) {
      const username = assigneeInfo.assigneeUsernames[i];
      if (!currentAssigneeLogins.includes(username)) {
        newAssigneeIds.push(assigneeInfo.assigneeNodeIds[i]);
        newAssigneeLogins.push(username);
        console.log(`➕ Will add ${username} via GraphQL`);
      } else {
        console.log(`ℹ️ ${username} already assigned`);
      }
    }
    
    if (newAssigneeIds.length === 0) {
      console.log(`ℹ️ All intended assignees already assigned`);
      return currentAssigneeLogins;
    }
    
    // GraphQL로 어사이니 추가
    const assignMutation = `
      mutation {
        addAssigneesToAssignable(input: {
          assignableId: "${issueId}",
          assigneeIds: ${JSON.stringify(newAssigneeIds)}
        }) {
          assignable {
            ... on Issue {
              id
              assignees(first: 10) {
                nodes {
                  login
                }
              }
            }
          }
        }
      }
    `;
    
    const assignResult = await github.graphql(assignMutation);
    const finalAssignees = assignResult.addAssigneesToAssignable.assignable.assignees.nodes;
    
    console.log(`✅ Successfully assigned via GraphQL to issue #${issueNumber}`);
    console.log(`Final assignees: ${finalAssignees.map(a => a.login).join(', ')}`);
    
    return finalAssignees.map(a => ({ login: a.login }));
    
  } catch (error) {
    console.log(`❌ Failed to assign using GraphQL:`, {
      message: error.message,
      errors: error.errors
    });
    return currentAssignees;
  }
}

/**
 * 통합 어사이니 할당 함수 - 이슈 생성과 동시에 할당
 * @param {Object} github - GitHub API 클라이언트
 * @param {Object} context - GitHub Actions context
 * @param {string} title - 이슈 제목
 * @param {string} body - 이슈 본문
 * @param {Array<string>} labels - 라벨 배열
 * @param {Array<string>} reviewers - 리뷰어 사용자명 배열
 * @param {boolean} includeCopilot - Copilot 포함 여부 (기본값: true)
 * @returns {Promise<Object>} 이슈 생성 및 할당 결과
 */
async function createIssueWithAssignees(github, context, title, body, labels = [], reviewers = [], includeCopilot = true) {
  console.log(`🚀 Starting integrated issue creation with assignees...`);
  
  // Step 1: 어사이니 준비
  const assigneeInfo = await prepareAssignees(github, context, reviewers, includeCopilot);
  
  // Step 2: GraphQL로 이슈 생성 및 할당 시도
  let issue = await createIssueWithGraphQL(github, context, title, body, labels, assigneeInfo);
  
  // Step 3: GraphQL 실패 시 REST API 폴백
  if (!issue) {
    console.log(`🔄 Creating issue via REST API fallback...`);
    
    const restIssue = await github.rest.issues.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      title: title,
      body: body,
      labels: labels
    });
    
    issue = {
      number: restIssue.data.number,
      id: restIssue.data.id,
      assignees: [],
      method: 'rest'
    };
    
    console.log(`✅ Created issue #${issue.number} via REST API`);
    
    // Step 4: REST API로 어사이니 할당
    const restAssignees = await assignUsersToIssue(github, context, issue.number, assigneeInfo);
    issue.assignees = restAssignees;
    
    // Step 5: REST API 실패 시 GraphQL로 추가 할당 시도
    if (restAssignees.length < assigneeInfo.assigneeUsernames.length) {
      console.log(`🔄 Attempting GraphQL assignment to complement REST API...`);
      const graphqlAssignees = await addAssigneesWithGraphQL(github, context, issue.number, assigneeInfo, restAssignees);
      issue.assignees = graphqlAssignees;
    }
  }
  
  // Step 6: 최종 검증
  let finalAssignees = [];
  try {
    const finalIssue = await github.rest.issues.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number
    });
    
    finalAssignees = finalIssue.data.assignees;
    console.log(`🔍 Final verification - ${finalAssignees.length} assignees: [${finalAssignees.map(a => a.login).join(', ')}]`);
  } catch (verifyError) {
    console.log(`⚠️ Could not verify final assignments: ${verifyError.message}`);
  }
  
  // 결과 요약
  const result = {
    issue: {
      number: issue.number,
      id: issue.id,
      method: issue.method
    },
    assignees: {
      requested: assigneeInfo.assigneeUsernames,
      final: finalAssignees.map(a => a.login),
      copilot: assigneeInfo.copilot,
      validReviewers: assigneeInfo.validReviewers.map(r => r.login),
      invalidReviewers: assigneeInfo.invalidReviewers
    },
    success: finalAssignees.length > 0,
    assignmentComplete: finalAssignees.length === assigneeInfo.assigneeUsernames.length
  };
  
  console.log(`📊 Final assignment summary:`);
  console.log(`  - Issue #${result.issue.number} created via ${result.issue.method}`);
  console.log(`  - Requested assignees: ${result.assignees.requested.length} [${result.assignees.requested.join(', ')}]`);
  console.log(`  - Final assignees: ${result.assignees.final.length} [${result.assignees.final.join(', ')}]`);
  console.log(`  - Assignment success: ${result.success}`);
  console.log(`  - Assignment complete: ${result.assignmentComplete}`);
  
  return result;
}

/**
 * 기존 이슈에 어사이니 할당하는 함수
 * @param {Object} github - GitHub API 클라이언트
 * @param {Object} context - GitHub Actions context
 * @param {number} issueNumber - 이슈 번호
 * @param {Array<string>} reviewers - 리뷰어 사용자명 배열
 * @param {boolean} includeCopilot - Copilot 포함 여부 (기본값: true)
 * @returns {Promise<Object>} 할당 결과
 */
async function assignToExistingIssue(github, context, issueNumber, reviewers = [], includeCopilot = true) {
  console.log(`🎯 Assigning to existing issue #${issueNumber}...`);
  
  // Step 1: 어사이니 준비
  const assigneeInfo = await prepareAssignees(github, context, reviewers, includeCopilot);
  
  // Step 2: REST API로 할당 시도
  const restAssignees = await assignUsersToIssue(github, context, issueNumber, assigneeInfo);
  
  // Step 3: REST API 실패 시 GraphQL로 추가 할당
  let finalAssignees = restAssignees;
  if (restAssignees.length < assigneeInfo.assigneeUsernames.length) {
    finalAssignees = await addAssigneesWithGraphQL(github, context, issueNumber, assigneeInfo, restAssignees);
  }
  
  // Step 4: 최종 검증
  try {
    const finalIssue = await github.rest.issues.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber
    });
    
    finalAssignees = finalIssue.data.assignees;
    console.log(`🔍 Final verification - ${finalAssignees.length} assignees: [${finalAssignees.map(a => a.login).join(', ')}]`);
  } catch (verifyError) {
    console.log(`⚠️ Could not verify final assignments: ${verifyError.message}`);
  }
  
  return {
    assignees: {
      requested: assigneeInfo.assigneeUsernames,
      final: finalAssignees.map(a => a.login),
      copilot: assigneeInfo.copilot,
      validReviewers: assigneeInfo.validReviewers.map(r => r.login),
      invalidReviewers: assigneeInfo.invalidReviewers
    },
    success: finalAssignees.length > 0,
    assignmentComplete: finalAssignees.length === assigneeInfo.assigneeUsernames.length
  };
}

module.exports = {
  validateGitHubUser,
  findCopilotBot,
  prepareAssignees,
  createIssueWithGraphQL,
  assignUsersToIssue,
  addAssigneesWithGraphQL,
  createIssueWithAssignees,
  assignToExistingIssue
};
